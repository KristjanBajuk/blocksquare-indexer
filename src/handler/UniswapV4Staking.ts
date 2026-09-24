import { getNewWallet } from "../helper/Wallet";
import { indexer } from "envio";
import type { EvmOnEventContext, UniswapV4PositionToken, UserCumulativeReward } from "envio";
import { getDay, getHour } from "../helper/date";
import { getLoadedConfig } from "../config";
import {
  BOOST_PRECISION,
  buildMerkleTree,
  computeV4PoolId,
  getPredictedDailyBlockCount,
  getUniswapV4StakingDeployementBlock,
  TOTAL_DAILY_REWARDS,
} from "../helper/UniswapV4Helpers/utils";
import { calculateActiveLiquidity } from "../helper/UniswapV4Helpers/liquidityAmounts";
import { StakingPoolV4PositionRecordType } from "../types/enums";

const { uniswapV4StakingAddress, chainId: loadedChainId } = getLoadedConfig();

/**
 * Cumulative rewards belong to the NFT, not to the wallet that staked it: the contract
 * verifies leaves of (tokenId, cumulativeReward) and tracks `totalClaimedRewards[tokenId]`.
 * Keying the record by tokenId keeps the total intact across withdrawals and resales.
 */
const getRewardRecordId = (chainId: number, tokenId: bigint) => `${chainId}-${tokenId}`;

/**
 * Resolves who a claim/burn for `tokenId` belongs to. The events only carry the tokenId,
 * and `transaction.from` can be a relayer or bundler, so it cannot be used.
 * - Staked: the staker of the open position.
 * - Unstaked: the current NFT holder; the history record links the latest closed position.
 */
const resolveRewardOwner = async (
  context: EvmOnEventContext,
  chainId: number,
  stakingPoolId: string,
  positionToken: UniswapV4PositionToken,
) => {
  const stakingPositions = (
    await context.StakingPoolV4Position.getWhere({ tokenId: { _eq: positionToken.tokenId } })
  )
    .filter((p) => p.pool_id === stakingPoolId)
    .sort((a, b) => b.updatedAtTimestamp - a.updatedAtTimestamp);

  const openPosition = stakingPositions.find((p) => !p.isPositionClosed);
  // The history record links to the position that earned the rewards: the open one, or else the
  // latest closed one. After a resale, a holder who hasn't staked yet (e.g. Dave claiming #44)
  // has no position of their own, so the claim links to the seller's closed position while
  // `walletId` names the holder.
  const stakingPosition = openPosition ?? stakingPositions[0];

  return {
    walletId: openPosition?.wallet_id ?? positionToken.wallet_id,
    stakingPositionId:
      stakingPosition?.id ?? `${chainId}-${positionToken.owner}-${positionToken.tokenId}`,
  };
};

indexer.onEvent({ contract: "UniswapV4Staking", event: "LPStakingInit" }, async ({ event, context }) => {
  /**
   * LPStakingInit event is emitted when a new staking pool is initialized.
   *
   * This event links:
   * - Staking contract configuration
   * - Target Uniswap V4 pool
   * - Reward / boost parameters
   */

  const {
    chainId,
    transaction: { hash: transactionHash },
    block: { timestamp },
    srcAddress: contractAddress,
  } = event;

  const {
    positionManager,
    targetPoolKey,
    minDays,
    maxDays,
    minBoost,
    maxBoost,
    earlyPositionSlash,
    earlyRewardSlash,
  } = event.params;

  // Uniswap V4 poolId = keccak256(abi.encode(PoolKey)). targetPoolKey is an
  // indexed tuple: real logs carry only its keccak topic hash (= the poolId),
  // while decoded forms (positional array or named object) need hashing here.
  const poolKey: unknown = targetPoolKey;
  let poolId: string;
  if (typeof poolKey === 'string') {
    poolId = poolKey;
  } else {
    const [currency0, currency1, fee, tickSpacing, hooks] = Array.isArray(poolKey)
      ? poolKey
      : [
          targetPoolKey.currency0,
          targetPoolKey.currency1,
          targetPoolKey.fee,
          targetPoolKey.tickSpacing,
          targetPoolKey.hooks,
        ];
    poolId = computeV4PoolId(currency0, currency1, fee, tickSpacing, hooks);
  }
  const uniV4PoolEntityId = `${chainId}-${poolId}`;

  const exitsingUniV4Pool = await context.UniswapV4Pool.get(uniV4PoolEntityId);

  if (exitsingUniV4Pool) {
    const stakingPoolEntityId = `${chainId}-${contractAddress}`;
    const existingContract =
      await context.StakingPoolV4.get(stakingPoolEntityId);

    if (!existingContract) {
      context.StakingPoolV4.set({
        id: stakingPoolEntityId,
        chainId,
        contractAddress,
        positionManager,
        targetPoolKey: poolId,
        minDays,
        maxDays,
        minBoost,
        maxBoost,
        earlyPositionSlash,
        earlyRewardSlash,
        totalRewardsAdded: 0n,
        totalRewardsClaimed: 0n,
        totalRewardsBurned: 0n,
        createdAtTimestamp: timestamp,
        creationTransaction: transactionHash,
        uniswapV4Pool_id: exitsingUniV4Pool.id,
      });
    }
  }
});

indexer.onEvent({ contract: "UniswapV4Staking", event: "Deposit" }, async ({ event, context }) => {
  /**
   * Deposit event is emitted when a user stakes their liquidity position NFT.
   *
   * This event updates staking state by linking:
   * - User wallet
   * - NFT position token
   * - Staking configuration
   *
   * Staking positions track:
   * - Locked liquidity
   * - Lock duration
   * - Boost multipliers
   */

  const {
    chainId,
    srcAddress: stakingContractAddress,
    transaction: { hash: transactionHash },
    block: { timestamp, number: blockNumber },
    logIndex,
  } = event;
  const { owner, tokenId, liquidity, lockedUntil, timeBoost } = event.params;

  /**
   * Get or create wallet entity for the staking user.
   */
  const wallet = await context.Wallet.getOrCreate(
    getNewWallet(event.chainId, owner),
  );

  /**
   * Find the associated Uniswap V4 NFT position token.
   */
  const uniTokenEntityId = `${chainId}-${tokenId}`;
  const existingUniToken =
    await context.UniswapV4PositionToken.get(uniTokenEntityId);

  /**
   * Only process staking logic if NFT position token exists.
   * This guarantees staking state is always linked to a valid liquidity position.
   */
  if (existingUniToken) {
    const stakingPoolEntityId = `${chainId}-${stakingContractAddress}`;
    const positionEntityId = `${chainId}-${owner}-${tokenId}`;
    const existingStakingPosition =
      await context.StakingPoolV4Position.get(positionEntityId);

    if (existingStakingPosition) {
      context.StakingPoolV4Position.set({
        ...existingStakingPosition,
        lockedUntil,
        positionToken_id: existingUniToken.id,
        liquidity,
        timeBoost,
        isPositionClosed: false,
        updatedAtTimestamp: timestamp,
      });
    } else {
      context.StakingPoolV4Position.set({
        id: positionEntityId,
        chainId,
        lockedUntil,
        tokenId,
        liquidity,
        timeBoost,
        isPositionClosed: false,
        updatedAtTimestamp: timestamp,
        wallet_id: wallet.id,
        pool_id: stakingPoolEntityId,
        positionToken_id: existingUniToken.id,
        uniPosition_id: existingUniToken.position_id,
      });
    }

    /**
     * The NFT's reward record now belongs to the new staker. Its cumulativeReward is
     * never reset: unclaimed rewards follow the NFT (the contract tracks claims per tokenId).
     */
    const rewardRecord = await context.UserCumulativeReward.get(
      getRewardRecordId(chainId, tokenId),
    );
    if (rewardRecord) {
      context.UserCumulativeReward.set({ ...rewardRecord, wallet_id: wallet.id });
    }

    const { id: hourId, start: hourStart } = getHour(event.block.timestamp);
    const { start: dayStart } = getDay(event.block.timestamp);

    context.StakingPoolV4PositionRecord.set({
      id: `${stakingPoolEntityId}-${existingUniToken.tokenId}-${hourId}-${logIndex}`,
      transactionHash,
      chainId,
      dayStartTimestamp: dayStart,
      blockTimestamp: timestamp,
      blockNumber,
      tokenId,
      pool_id: stakingPoolEntityId,
      rewardsClaimed: 0n,
      rewardsBurned: 0n,
      transactionType: StakingPoolV4PositionRecordType.DEPOSIT,
      stakingPosition_id: positionEntityId,
      wallet_id: wallet.id
    });
  }
});

indexer.onEvent({ contract: "UniswapV4Staking", event: "Withdraw" }, async ({ event, context }) => {
  /**
   * Withdraw event is emitted when a user unstakes their liquidity position NFT.
   *
   * This event updates staking state by:
   * - Closing staking position lifecycle
   * - Historical activity tracking
   */

  const {
    chainId,
    transaction: { hash: transactionHash },
    srcAddress: stakingContractAddress,
    block: { timestamp, number: blockNumber },
    logIndex,
  } = event;
  const { owner, tokenId } = event.params;

  const stakingPositionEntityId = `${chainId}-${owner}-${tokenId}`;
  const stakingPosition = await context.StakingPoolV4Position.get(
    stakingPositionEntityId,
  );

  if (stakingPosition) {
    /**
     * Mark staking position as closed since liquidity is withdrawn.
     */
    context.StakingPoolV4Position.set({
      ...stakingPosition,
      isPositionClosed: true,
      updatedAtTimestamp: timestamp,
    });

    const { id: hourId, start: hourStart } = getHour(event.block.timestamp);
    const { start: dayStart } = getDay(event.block.timestamp);

    const stakingContractId = `${chainId}-${stakingContractAddress}`;

    context.StakingPoolV4PositionRecord.set({
      id: `${stakingPosition.pool_id}-${tokenId}-${hourId}-${logIndex}`,
      transactionHash,
      chainId,
      dayStartTimestamp: dayStart,
      blockTimestamp: timestamp,
      blockNumber,
      tokenId,
      rewardsClaimed: 0n,
      rewardsBurned: 0n,
      transactionType: StakingPoolV4PositionRecordType.WITHDRAW,
      pool_id: stakingContractId,
      stakingPosition_id: stakingPositionEntityId,
      wallet_id: `${chainId}-${owner}`
    });
  }
});

indexer.onEvent({ contract: "UniswapV4Staking", event: "EarlyWithdraw" }, async ({ event, context }) => {
  /**
   * EarlyWithdraw event is emitted when a user withdraws liquidity
   * before the staking lock period is completed.
   *
   * Early withdrawals usually trigger:
   * - Position lifecycle closure
   * - Potential penalty / slash logic (handled on contract side)
   * - Historical activity tracking
   */

  const {
    chainId,
    transaction: { hash: transactionHash },
    srcAddress: stakingContractAddress,
    block: { timestamp, number: blockNumber },
    logIndex,
  } = event;
  const { owner, tokenId } = event.params;

  const stakingPositionEntityId = `${chainId}-${owner}-${tokenId}`;

  const stakingPosition = await context.StakingPoolV4Position.get(
    stakingPositionEntityId,
  );

  if (stakingPosition) {
    /**
     * Mark position as closed since liquidity is withdrawn early.
     */
    context.StakingPoolV4Position.set({
      ...stakingPosition,
      isPositionClosed: true,
      updatedAtTimestamp: timestamp,
    });

    const { id: hourId, start: hourStart } = getHour(event.block.timestamp);
    const { start: dayStart } = getDay(event.block.timestamp);

    const stakingContractId = `${chainId}-${stakingContractAddress}`;

    context.StakingPoolV4PositionRecord.set({
      id: `${stakingPosition.pool_id}-${tokenId}-${hourId}-${logIndex}`,
      transactionHash,
      chainId,
      dayStartTimestamp: dayStart,
      blockTimestamp: timestamp,
      blockNumber,
      tokenId,
      rewardsClaimed: 0n,
      rewardsBurned: 0n,
      transactionType: StakingPoolV4PositionRecordType.EARLY_WITHDRAW,
      pool_id: stakingContractId,
      stakingPosition_id: stakingPositionEntityId,
      wallet_id: `${chainId}-${owner}`
    });
  }
});

indexer.onBlock(
  {
    name: "DailyUniswapV4StakingRewards",
    where: ({ chain }) => {
      if (chain.id !== loadedChainId) return false;
      return {
        block: {
          number: {
            _gte: getUniswapV4StakingDeployementBlock(loadedChainId),
            _every: getPredictedDailyBlockCount(loadedChainId),
          },
        },
      };
    },
  },
  async ({ block, context }) => {
    /**
     * DailyRewards Handler
     * ---------------------
     * This onBlock handler runs once per day (based on chain block time) to calculate
     * cumulative rewards for all active staked positions in the Uniswap V4 staking pool.
     *
     * It computes each user's share of the daily reward pool based on the active liquidity
     * (in-range positions) of their staked Uniswap V4 position. A Merkle tree is built
     * from the cumulative rewards (tokenId + cumulativeReward) and the root is stored.
     * Each user's cumulative reward record is updated with the new total and linked to
     * the current Merkle root. These records are later marked as distributed when the
     * `Reward` event is emitted.
     */

    if (context.isPreload) return;

    const STAKING_POOL_ENTITY_ID = `${loadedChainId}-${uniswapV4StakingAddress}`;

    // Fetch staking pool and associated Uniswap pool. If either doesn't exist, we cannot calculate rewards.
    const stakingPool = await context.StakingPoolV4.get(STAKING_POOL_ENTITY_ID);
    if (!stakingPool) return;

    const uniV4Pool = await context.UniswapV4Pool.get(
      stakingPool.uniswapV4Pool_id,
    );
    if (!uniV4Pool) return;

    // Fetch all open staked positions for this pool in a single multi-field query.
    const activeStakedPositions = [
      ...(await context.StakingPoolV4Position.getWhere({
        pool_id: { _eq: STAKING_POOL_ENTITY_ID },
        isPositionClosed: { _eq: false },
      })),
    ].sort((a, b) => a.updatedAtTimestamp - b.updatedAtTimestamp);
    if (activeStakedPositions.length === 0) return;

    const uniPositions = await context.UniswapV4PoolPosition.getWhere({
      pool_id: { _eq: uniV4Pool.id },
    });

    // Compute total active liquidity and build list of eligible positions.
    // Only positions that are in-range (active liquidity > 0) qualify for rewards.
    let totalEffectiveLiquidity = 0n;
    const rewardCandidates: Array<{
      stakedPosition: (typeof activeStakedPositions)[0];
      uniPosition: (typeof uniPositions)[0];
      effectiveLiquidity: bigint;
    }> = [];

    for (const stakedPosition of activeStakedPositions) {
      const uniPosition = uniPositions.find(
        (p) => p.id === stakedPosition.uniPosition_id,
      );
      if (!uniPosition) continue;

      // Determine if the position is currently in-range.
      const activeLiquidity = calculateActiveLiquidity(
        uniPosition,
        uniV4Pool.tick,
      );
      if (activeLiquidity === 0n) continue; // skip out-of-range positions

      // Apply time-based boost to active liquidity.
      // `timeBoost` is expressed as a percentage with base 100 (e.g. 100 = 1.0x, 122 = 1.22x).
      // This increases a position's reward share proportionally to its lock duration.
      // Effective liquidity = active liquidity × boost multiplier.
      const effectiveLiquidity =
        (activeLiquidity * stakedPosition.timeBoost) / BOOST_PRECISION;

      totalEffectiveLiquidity += effectiveLiquidity;
      rewardCandidates.push({
        stakedPosition,
        uniPosition,
        effectiveLiquidity,
      });
    }

    // If no positions are in-range, no rewards to distribute. Don't publish a new root:
    // the previous one stays valid on-chain.
    if (totalEffectiveLiquidity === 0n) return;

    // Today's share per NFT, keyed by reward record ID.
    const dailyShares = new Map<string, bigint>();
    const earnersByRecordId = new Map<string, (typeof rewardCandidates)[0]>();
    for (const candidate of rewardCandidates) {
      const recordId = getRewardRecordId(loadedChainId, candidate.stakedPosition.tokenId);
      const rewardAmount =
        (TOTAL_DAILY_REWARDS * candidate.effectiveLiquidity) / totalEffectiveLiquidity;
      dailyShares.set(recordId, (dailyShares.get(recordId) ?? 0n) + rewardAmount);
      earnersByRecordId.set(recordId, candidate);
    }

    // The contract only accepts proofs against the latest root, so every NFT that has
    // ever earned must be in every tree: today's earners plus every existing record,
    // including withdrawn, out-of-range and resold positions (carried forward unchanged).
    const existingRecords = await context.UserCumulativeReward.getWhere({
      stakingPool_id: { _eq: STAKING_POOL_ENTITY_ID },
    });
    const recordsById = new Map<string, UserCumulativeReward>(
      existingRecords.map((record) => [record.id, record]),
    );

    for (const [recordId, candidate] of earnersByRecordId) {
      if (recordsById.has(recordId)) continue;
      recordsById.set(recordId, {
        id: recordId,
        tokenId: candidate.stakedPosition.tokenId,
        cumulativeReward: 0n,
        lastDistributedCumulativeReward: 0n,
        updatedAtTimestamp: 0,
        merkleRoot: "",
        lastDistributedMerkleRoot: "",
        isRewardsDistributed: false,
        distributionSkipped: false,
        blockNumber: block.number,
        wallet_id: candidate.stakedPosition.wallet_id,
        stakingPool_id: STAKING_POOL_ENTITY_ID,
        uniPosition_id: candidate.uniPosition.id,
        proof: [],
        lastDistributedProof: [],
        claimed: 0n,
        burned: 0n,
      });
    }

    // New cumulative totals. Records with a zero total have nothing to claim and get no leaf.
    // Sorted by tokenId so the same state always produces the same root.
    const updatedRecords = [...recordsById.values()]
      .map((record) => {
        const earner = earnersByRecordId.get(record.id);
        return {
          ...record,
          cumulativeReward: record.cumulativeReward + (dailyShares.get(record.id) ?? 0n),
          // Earners follow their current staking position; carried-forward records keep theirs.
          wallet_id: earner?.stakedPosition.wallet_id ?? record.wallet_id,
          uniPosition_id: earner?.uniPosition.id ?? record.uniPosition_id,
        };
      })
      .filter((record) => record.cumulativeReward > 0n)
      .sort((a, b) => (a.tokenId < b.tokenId ? -1 : a.tokenId > b.tokenId ? 1 : 0));

    // Each leaf in the Merkle tree is the hash of (tokenId, cumulativeReward).
    const { root: merkleRoot, tree } = buildMerkleTree(updatedRecords);

    // Rewrite every record in the tree with the new root and a fresh proof, marked pending
    // (updatedAtTimestamp = 0) until the `Reward` event publishes this root.
    // Leaves are in `updatedRecords` order, so each proof is looked up by index: looking it up
    // by leaf hash scans every leaf per record, which is quadratic (~20s at 50k records).
    for (const [index, record] of updatedRecords.entries()) {
      context.UserCumulativeReward.set({
        ...record,
        updatedAtTimestamp: 0,
        merkleRoot,
        proof: tree.getHexProof(tree.getLeaf(index), index),
        isRewardsDistributed: false,
        distributionSkipped: false,
        blockNumber: block.number,
      });
    }
  },
);

indexer.onEvent({ contract: "UniswapV4Staking", event: "Reward" }, async ({ event, context }) => {
  /**
   * Reward Event Handler
   * --------------------
   * Triggered when a rewards distribution occurs on-chain from the staking contract
   *
   * This handler:
   * 1. Updates the staking pool's total rewards added.
   * 2. Records an hourly/daily aggregate record for the pool.
   * 3. Marks all pending cumulative reward records as either distributed (if their merkle root matches)
   *    or skipped (if they belong to a different root). Pending records are those with updatedAtTimestamp = 0.
   */
  const {
    chainId,
    block: { timestamp },
    params: { merkleRoot, amount },
    srcAddress: stakingContractAddress,
    transaction: { hash },
  } = event;

  const stakingEntityId = `${chainId}-${stakingContractAddress}`;

  const stakingPool = await context.StakingPoolV4.get(stakingEntityId);
  if (!stakingPool) return;

  const { id: hourId, start: hourStart } = getHour(timestamp);
  const { start: dayStart } = getDay(timestamp);

  const updatedTotalRewards = stakingPool.totalRewardsAdded + amount;
  context.StakingPoolV4.set({
    ...stakingPool,
    totalRewardsAdded: updatedTotalRewards,
  });

  context.StakingPoolV4Record.set({
    id: `${stakingPool.id}-${hourId}`,
    chainId,
    dayStartTimestamp: dayStart,
    hourStartTimestamp: hourStart,
    pool_id: stakingPool.id,
    totalRewards: updatedTotalRewards,
    transactionHash: hash,
    merkleRoot,
  });

  // Fetch all pending cumulative reward records.
  // A pending record has updatedAtTimestamp = 0, meaning it was created
  // by a daily rewards calculation but not yet marked as distributed.
  // - `lastDistributedCumulativeReward` / `lastDistributedMerkleRoot` store the values from the most recent
  // successful distribution for this user. This provides a fallback for the frontend if the latest
  // cumulative reward (from a daily calculation) has not yet been distributed on-chain.
  const pendingRewards = await context.UserCumulativeReward.getWhere({
    updatedAtTimestamp: { _eq: 0 },
  });
  if (pendingRewards.length === 0) return;

  // Update each pending reward: mark as distributed if merkleRoot matches, otherwise skipped
  for (const pending of pendingRewards) {
    const isMatch = pending.merkleRoot === merkleRoot;

    context.UserCumulativeReward.set({
      ...pending,
      lastDistributedCumulativeReward: isMatch
        ? pending.cumulativeReward
        : pending.lastDistributedCumulativeReward,
      lastDistributedMerkleRoot: isMatch
        ? pending.merkleRoot
        : pending.lastDistributedMerkleRoot,
      lastDistributedProof: isMatch
        ? pending.proof
        : pending.lastDistributedProof,
      isRewardsDistributed: isMatch,
      updatedAtTimestamp: timestamp,
      distributionSkipped: !isMatch,
    });
  }
});

indexer.onEvent({ contract: "UniswapV4Staking", event: "RewardsClaimed" }, async ({ event, context }) => {
  /**
   * RewardsClaimed Event Handler
   * -----------------------------
   * Triggered when a user claims rewards from the staking contract
   *
   * This handler:
   * 1. Updates the staking pool's total claimed rewards.
   * 2. Creates a position record entry for the claim, used for historical tracking and aggregation.
   */

  const {
    chainId,
    block: { timestamp, number: blockNumber },
    params: { tokenId, amount },
    srcAddress: stakingContractAddress,
    transaction: { hash },
    logIndex,
  } = event;

  const { id: hourId, start: hourStart } = getHour(timestamp);
  const { start: dayStart } = getDay(timestamp);

  const tokenEntityId = `${chainId}-${tokenId}`;
  const stakingEntityId = `${chainId}-${stakingContractAddress}`;

  const uniswapV4PositionToken =
    await context.UniswapV4PositionToken.get(tokenEntityId);
  if (!uniswapV4PositionToken) return;

  const stakingPool = await context.StakingPoolV4.get(stakingEntityId);
  if (!stakingPool) return;

  // Rewards are tracked per tokenId, like the contract does. The reward owner is resolved
  // from staking state rather than `transaction.from`, which may be a relayer or bundler.
  const { walletId: walletEntityId, stakingPositionId: stakingPositionEntityId } =
    await resolveRewardOwner(context, chainId, stakingPool.id, uniswapV4PositionToken);
  const cumilativeRewardsDataEntityId = getRewardRecordId(chainId, tokenId);
  const cumilativeRewardsData = await context.UserCumulativeReward.get(
    cumilativeRewardsDataEntityId,
  );

  context.StakingPoolV4.set({
    ...stakingPool,
    totalRewardsClaimed: stakingPool.totalRewardsClaimed + amount,
  });

  context.StakingPoolV4PositionRecord.set({
    id: `${stakingPool.id}-${uniswapV4PositionToken.tokenId}-${hourId}-${logIndex}`,
    chainId,
    dayStartTimestamp: dayStart,
    blockTimestamp: timestamp,
    blockNumber,
    pool_id: stakingPool.id,
    rewardsClaimed: amount,
    rewardsBurned: 0n,
    transactionHash: hash,
    tokenId: uniswapV4PositionToken.tokenId,
    transactionType: StakingPoolV4PositionRecordType.REWARDS_CLAIMED,
    stakingPosition_id: stakingPositionEntityId,
    wallet_id: walletEntityId
  });

  if (cumilativeRewardsData) {
    context.UserCumulativeReward.set({
      ...cumilativeRewardsData,
      claimed: cumilativeRewardsData.claimed + amount,
      // The record follows the current owner, e.g. a buyer claiming before staking.
      wallet_id: walletEntityId,
    });
  } else {
    context.UserCumulativeReward.set({
      id: cumilativeRewardsDataEntityId,
      tokenId,
      cumulativeReward: 0n,
      lastDistributedCumulativeReward: 0n,
      updatedAtTimestamp: 0,
      merkleRoot: "",
      lastDistributedMerkleRoot: "",
      isRewardsDistributed: false,
      distributionSkipped: false,
      blockNumber: 0,
      wallet_id: walletEntityId,
      stakingPool_id: stakingPool.id,
      uniPosition_id: uniswapV4PositionToken.position_id,
      proof: [""],
      lastDistributedProof: [],
      claimed: amount,
      burned: 0n,
    });
  }
});

indexer.onEvent({ contract: "UniswapV4Staking", event: "RewardsBurned" }, async ({ event, context }) => {
  /**
   * RewardsBurned Event Handler
   * ----------------------------
   * Triggered when rewards are burned (slashed) due to early withdrawal or other penalties
   *
   * This handler:
   * 1. Updates the staking pool's total burned rewards.
   * 2. Creates a position record entry for the burn, used for historical tracking and aggregation.
   */

  const {
    chainId,
    block: { timestamp, number: blockNumber },
    params: { tokenId, amount },
    srcAddress: stakingContractAddress,
    transaction: { hash },
    logIndex,
  } = event;

  const { id: hourId, start: hourStart } = getHour(timestamp);
  const { start: dayStart } = getDay(timestamp);

  const tokenEntityId = `${chainId}-${tokenId}`;
  const stakingEntityId = `${chainId}-${stakingContractAddress}`;

  const uniswapV4PositionToken =
    await context.UniswapV4PositionToken.get(tokenEntityId);
  if (!uniswapV4PositionToken) return;

  const stakingPool = await context.StakingPoolV4.get(stakingEntityId);
  if (!stakingPool) return;

  // Rewards are tracked per tokenId, like the contract does. The reward owner is resolved
  // from staking state rather than `transaction.from`, which may be a relayer or bundler.
  const { walletId: walletEntityId, stakingPositionId: stakingPositionEntityId } =
    await resolveRewardOwner(context, chainId, stakingPool.id, uniswapV4PositionToken);
  const cumilativeRewardsDataEntityId = getRewardRecordId(chainId, tokenId);
  const cumilativeRewardsData = await context.UserCumulativeReward.get(
    cumilativeRewardsDataEntityId,
  );

  context.StakingPoolV4.set({
    ...stakingPool,
    totalRewardsBurned: stakingPool.totalRewardsBurned + amount,
  });

  context.StakingPoolV4PositionRecord.set({
    id: `${stakingPool.id}-${uniswapV4PositionToken.tokenId}-${hourId}-${logIndex}`,
    chainId,
    dayStartTimestamp: dayStart,
    blockTimestamp: timestamp,
    blockNumber,
    pool_id: stakingPool.id,
    rewardsClaimed: 0n,
    rewardsBurned: amount,
    transactionHash: hash,
    tokenId: uniswapV4PositionToken.tokenId,
    transactionType: StakingPoolV4PositionRecordType.REWARDS_BURNED,
    stakingPosition_id: stakingPositionEntityId,
    wallet_id: walletEntityId
  });

  if (cumilativeRewardsData) {
    context.UserCumulativeReward.set({
      ...cumilativeRewardsData,
      burned: cumilativeRewardsData.burned + amount,
      // The record follows the current owner, e.g. a buyer claiming before staking.
      wallet_id: walletEntityId,
    });
  } else {
    context.UserCumulativeReward.set({
      id: cumilativeRewardsDataEntityId,
      tokenId,
      cumulativeReward: 0n,
      lastDistributedCumulativeReward: 0n,
      updatedAtTimestamp: 0,
      merkleRoot: "",
      lastDistributedMerkleRoot: "",
      isRewardsDistributed: false,
      distributionSkipped: false,
      blockNumber: 0,
      wallet_id: walletEntityId,
      stakingPool_id: stakingPool.id,
      uniPosition_id: uniswapV4PositionToken.position_id,
      proof: [""],
      lastDistributedProof: [],
      claimed: 0n,
      burned: amount,
    });
  }
});
