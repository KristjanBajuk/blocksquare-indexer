import { getNewWallet } from "../helper/Wallet";
import { indexer } from "envio";
import type { EvmEvent, EvmOnEventContext, UserCumulativeReward } from "envio";
import { getDay, getHour } from "../helper/date";
import { getLoadedConfig } from "../config";
import {
  BOOST_PRECISION,
  buildMerkleTree,
  compareRewardBuckets,
  computeV4PoolId,
  getPredictedDailyBlockCount,
  getUniswapV4StakingDeployementBlock,
  TOTAL_DAILY_REWARDS,
} from "../helper/UniswapV4Helpers/utils";
import { calculateActiveLiquidity } from "../helper/UniswapV4Helpers/liquidityAmounts";
import { getBlockTimestamp } from "../helper/blockTimestamp";
import { StakingPoolV4PositionRecordType } from "../types/enums";
import {
  getNewUserCumulativeReward,
  getReleasableBoostReward,
  getRewardRecordId,
  getStakingPoolId,
  getStakingPositionId,
  recordRewardPayout,
  writeStakingHistoryRecord,
} from "../helper/UniswapV4Staking";

const { uniswapV4StakingAddress, chainId: loadedChainId } = getLoadedConfig();

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
    const stakingPoolEntityId = getStakingPoolId(chainId, contractAddress);
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
   * - The deposit's epoch: every deposit starts a new, empty reward bucket (tokenId, epoch)
   */

  const {
    chainId,
    srcAddress: stakingContractAddress,
    block: { timestamp },
  } = event;
  const { owner, tokenId, epoch, liquidity, lockedUntil, timeBoost } = event.params;

  /**
   * Get or create wallet entity for the staking user.
   */
  const wallet = await context.Wallet.getOrCreate(getNewWallet(chainId, owner));

  /**
   * Only process staking logic if NFT position token exists.
   * This guarantees staking state is always linked to a valid liquidity position.
   */
  const positionToken = await context.UniswapV4PositionToken.get(`${chainId}-${tokenId}`);
  if (!positionToken) return;

  const stakingPoolId = getStakingPoolId(chainId, stakingContractAddress);
  const stakingPositionId = getStakingPositionId(chainId, owner, tokenId);

  // Creates the position, or reopens it with the new terms when the same owner re-deposits.
  context.StakingPoolV4Position.set({
    id: stakingPositionId,
    chainId,
    tokenId,
    epoch,
    lockedUntil,
    liquidity,
    timeBoost,
    stakingTimestamp: timestamp,
    isPositionClosed: false,
    updatedAtTimestamp: timestamp,
    wallet_id: wallet.id,
    pool_id: stakingPoolId,
    positionToken_id: positionToken.id,
    uniPosition_id: positionToken.position_id,
  });

  /**
   * The NFT's reward records of earlier epochs now belong to the new staker: unclaimed
   * rewards follow the NFT. No record is created for the new epoch here; the daily run
   * creates it when this deposit first earns.
   */
  const rewardRecords = await context.UserCumulativeReward.getWhere({
    tokenId: { _eq: tokenId },
    stakingPool_id: { _eq: stakingPoolId },
  });
  for (const rewardRecord of rewardRecords) {
    context.UserCumulativeReward.set({ ...rewardRecord, wallet_id: wallet.id });
  }

  writeStakingHistoryRecord(context, event, {
    tokenId,
    epoch,
    transactionType: StakingPoolV4PositionRecordType.DEPOSIT,
    pool_id: stakingPoolId,
    stakingPosition_id: stakingPositionId,
    wallet_id: wallet.id,
  });
});

/**
 * Shared body of the Withdraw and EarlyWithdraw handlers: closes the staking position and
 * writes a history record. `epoch` defaults to the position's current epoch, since Withdraw
 * carries none: a normal withdraw always ends the current epoch.
 */
const closeStakingPosition = async (
  event:
    | EvmEvent<"UniswapV4Staking", "Withdraw">
    | EvmEvent<"UniswapV4Staking", "EarlyWithdraw">,
  context: EvmOnEventContext,
  transactionType:
    | StakingPoolV4PositionRecordType.WITHDRAW
    | StakingPoolV4PositionRecordType.EARLY_WITHDRAW,
  epoch?: bigint,
) => {
  const {
    chainId,
    block: { timestamp },
    params: { owner, tokenId },
  } = event;

  const stakingPositionId = getStakingPositionId(chainId, owner, tokenId);
  const stakingPosition = await context.StakingPoolV4Position.get(stakingPositionId);
  if (!stakingPosition) return;

  context.StakingPoolV4Position.set({
    ...stakingPosition,
    isPositionClosed: true,
    updatedAtTimestamp: timestamp,
  });

  writeStakingHistoryRecord(context, event, {
    tokenId,
    epoch: epoch ?? stakingPosition.epoch,
    transactionType,
    pool_id: stakingPosition.pool_id,
    stakingPosition_id: stakingPositionId,
    wallet_id: stakingPosition.wallet_id,
  });
};

/**
 * Withdraw event is emitted when a user unstakes their liquidity position NFT
 * after the lock period.
 */
indexer.onEvent({ contract: "UniswapV4Staking", event: "Withdraw" }, ({ event, context }) =>
  closeStakingPosition(event, context, StakingPoolV4PositionRecordType.WITHDRAW),
);

indexer.onEvent({ contract: "UniswapV4Staking", event: "EarlyWithdraw" }, async ({ event, context }) => {
  /**
   * EarlyWithdraw event is emitted when a user withdraws liquidity
   * before the staking lock period is completed.
   *
   * Early withdrawals trigger:
   * - Position lifecycle closure
   * - A position slash: `positionSlash` is an amount of liquidity sent to the treasury
   * - A reward slash: `rewardSlash` is a rate (100000 scale) stored on-chain for this epoch,
   *   applied to every later claim of the epoch
   * - The held boost bonus is cut to what the days actually served earned
   * - Historical activity tracking
   */
  const {
    chainId,
    block: { timestamp },
  } = event;
  const { owner, tokenId, epoch, rewardSlash } = event.params;

  // A deposit that exits before any daily run has no record yet: nothing to slash or prorate.
  const rewardRecord = await context.UserCumulativeReward.get(
    getRewardRecordId(chainId, tokenId, epoch),
  );
  if (rewardRecord) {
    const position = await context.StakingPoolV4Position.get(
      getStakingPositionId(chainId, owner, tokenId),
    );
    const pool = position && (await context.StakingPoolV4.get(position.pool_id));

    // Keep only the boost bonus the days served earned; the rest is forfeited and never enters a
    // leaf. What is left in pendingBoostReward is released into the leaf by the next daily run.
    const pending = rewardRecord.pendingBoostReward;
    const releasable =
      position && pool
        ? getReleasableBoostReward({
            pending,
            timeBoost: position.timeBoost,
            stakingTimestamp: position.stakingTimestamp,
            exitTimestamp: timestamp,
            pool,
          })
        : pending;

    context.UserCumulativeReward.set({
      ...rewardRecord,
      // Stored so the UI can show the epoch's slash without an RPC call.
      rewardSlash,
      pendingBoostReward: releasable,
      forfeitedBoostReward: rewardRecord.forfeitedBoostReward + pending - releasable,
    });
  }

  await closeStakingPosition(event, context, StakingPoolV4PositionRecordType.EARLY_WITHDRAW, epoch);
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
     * This onBlock handler runs once per day (based on chain block time) and builds the
     * reward Merkle tree for the Uniswap V4 staking pool.
     *
     * Today's reward pool is split between open, in-range staked positions by active
     * liquidity × time boost (only while the position is still locked), and each share is added to the cumulative reward record of
     * that position's current deposit (one record per (tokenId, epoch)). Only the 1x base of a
     * share goes into the leaf; the boost bonus is held in pendingBoostReward until the deposit's
     * lock is completed, so leaving early can't keep a boost that wasn't earned. The tree covers
     * every deposit that has ever earned: records that didn't earn today carry forward
     * unchanged, because the contract only accepts proofs against its latest root. Every record in the tree is
     * rewritten with the new root and its proof, and later marked as distributed when
     * the `Reward` event publishes that root.
     */

    if (context.isPreload) return;

    const STAKING_POOL_ENTITY_ID = getStakingPoolId(loadedChainId, uniswapV4StakingAddress);

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

    // Block handlers only receive the block number, so the run's timestamp is read from the chain.
    const now = BigInt(
      await context.effect(getBlockTimestamp, { chainId: loadedChainId, blockNumber: block.number }),
    );

    const uniPositions = await context.UniswapV4PoolPosition.getWhere({
      pool_id: { _eq: uniV4Pool.id },
    });

    // Compute total active liquidity and build list of eligible positions.
    // Only positions that are in-range (active liquidity > 0) qualify for rewards.
    let totalEffectiveLiquidity = 0n;
    const rewardCandidates: Array<{
      stakedPosition: (typeof activeStakedPositions)[0];
      uniPosition: (typeof uniPositions)[0];
      boost: bigint;
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
      // It pays for the promise not to leave, so it applies only while the position is locked.
      // From `lockedUntil` on, the contract lets the position exit without a slash, and it earns 1x.
      // Effective liquidity = active liquidity × boost multiplier.
      const boost = now < stakedPosition.lockedUntil ? stakedPosition.timeBoost : BOOST_PRECISION;
      const effectiveLiquidity = (activeLiquidity * boost) / BOOST_PRECISION;

      totalEffectiveLiquidity += effectiveLiquidity;
      rewardCandidates.push({
        stakedPosition,
        uniPosition,
        boost,
        effectiveLiquidity,
      });
    }

    // If no positions are in-range, no rewards to distribute. Don't publish a new root:
    // the previous one stays valid on-chain.
    if (totalEffectiveLiquidity === 0n) return;

    // Today's earners, keyed by reward record ID, with their share of the daily pool. `base` is
    // the part the share would be at 1x; the rest (share − base) is the boost bonus.
    const earners = new Map<
      string,
      { candidate: (typeof rewardCandidates)[0]; share: bigint; base: bigint }
    >();
    for (const candidate of rewardCandidates) {
      const { tokenId, epoch } = candidate.stakedPosition;
      const recordId = getRewardRecordId(loadedChainId, tokenId, epoch);
      const share = (TOTAL_DAILY_REWARDS * candidate.effectiveLiquidity) / totalEffectiveLiquidity;
      const base = (share * BOOST_PRECISION) / candidate.boost;
      const previous = earners.get(recordId);
      earners.set(recordId, {
        candidate,
        share: (previous?.share ?? 0n) + share,
        base: (previous?.base ?? 0n) + base,
      });
    }

    // Deposits still staked and locked keep their boost bonus held back. Every other deposit
    // (lock completed, withdrawn, or exited early and already prorated) gets it released.
    const lockedRecordIds = new Set(
      activeStakedPositions
        .filter((position) => now < position.lockedUntil)
        .map((position) => getRewardRecordId(loadedChainId, position.tokenId, position.epoch)),
    );

    // The contract only accepts proofs against the latest root, so every deposit that has
    // ever earned must be in every tree: today's earners plus every existing record,
    // including earlier epochs and withdrawn, out-of-range and resold positions (carried
    // forward unchanged).
    const existingRecords = await context.UserCumulativeReward.getWhere({
      stakingPool_id: { _eq: STAKING_POOL_ENTITY_ID },
    });
    const recordsById = new Map<string, UserCumulativeReward>(
      existingRecords.map((record) => [record.id, record]),
    );

    for (const [recordId, { candidate }] of earners) {
      if (recordsById.has(recordId)) continue;
      recordsById.set(
        recordId,
        getNewUserCumulativeReward({
          chainId: loadedChainId,
          tokenId: candidate.stakedPosition.tokenId,
          epoch: candidate.stakedPosition.epoch,
          walletId: candidate.stakedPosition.wallet_id,
          stakingPoolId: STAKING_POOL_ENTITY_ID,
          uniPositionId: candidate.uniPosition.id,
          blockNumber: block.number,
        }),
      );
    }

    // New totals: the base of today's share goes into the leaf, the bonus into pendingBoostReward,
    // and a deposit that is no longer locked gets all of its pending bonus moved into the leaf.
    // Totals only change here, together with the tree, so a record's proof always matches it.
    const mergedRecords = [...recordsById.values()].map((record) => {
      const earner = earners.get(record.id);
      const pending = record.pendingBoostReward + (earner ? earner.share - earner.base : 0n);
      const released = lockedRecordIds.has(record.id) ? 0n : pending;
      return {
        ...record,
        cumulativeReward: record.cumulativeReward + (earner?.base ?? 0n) + released,
        pendingBoostReward: pending - released,
        // Earners follow their current staking position; carried-forward records keep theirs.
        wallet_id: earner?.candidate.stakedPosition.wallet_id ?? record.wallet_id,
        uniPosition_id: earner?.candidate.uniPosition.id ?? record.uniPosition_id,
      };
    });

    // Records with a zero total have nothing to claim and get no leaf.
    // Sorted by (tokenId, epoch) so the same state always produces the same root.
    const updatedRecords = mergedRecords
      .filter((record) => record.cumulativeReward > 0n)
      .sort(compareRewardBuckets);

    // A record whose share so far is all held-back bonus has no leaf yet, but must keep its bonus.
    for (const record of mergedRecords) {
      if (record.cumulativeReward === 0n && record.pendingBoostReward > 0n) {
        context.UserCumulativeReward.set(record);
      }
    }

    // Each leaf in the Merkle tree is the hash of (tokenId, epoch, cumulativeReward). Held-back
    // bonus is not in any leaf, so the operator doesn't fund it until it is released.
    const { root: merkleRoot, proofs } = buildMerkleTree(updatedRecords);

    // Rewrite every record in the tree with the new root and a fresh proof, marked pending
    // (updatedAtTimestamp = 0) until the `Reward` event publishes this root.
    // `proofs[i]` belongs to `updatedRecords[i]`.
    for (const [index, record] of updatedRecords.entries()) {
      context.UserCumulativeReward.set({
        ...record,
        updatedAtTimestamp: 0,
        merkleRoot,
        proof: proofs[index]!,
        isRewardsDistributed: false,
        distributionSkipped: false,
        blockNumber: block.number,
      });
    }

    // One entity per tree, so the operator can read the latest root and how much it needs
    // funding with a single query.
    context.StakingPoolV4RewardTree.set({
      id: `${STAKING_POOL_ENTITY_ID}-${block.number}`,
      chainId: loadedChainId,
      merkleRoot,
      blockNumber: block.number,
      leafCount: updatedRecords.length,
      totalCumulativeReward: updatedRecords.reduce((sum, r) => sum + r.cumulativeReward, 0n),
      dailyReward: [...earners.values()].reduce((sum, e) => sum + e.share, 0n),
      totalPendingBoostReward: mergedRecords.reduce((sum, r) => sum + r.pendingBoostReward, 0n),
      isPublished: false,
      publishedAtTimestamp: undefined,
      publishedTransactionHash: undefined,
      publishedAmount: undefined,
      pool_id: STAKING_POOL_ENTITY_ID,
    });
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
   * 4. Marks the reward tree with this root as published.
   */
  const {
    chainId,
    block: { timestamp },
    params: { merkleRoot, amount },
    srcAddress: stakingContractAddress,
    transaction: { hash },
  } = event;

  const stakingEntityId = getStakingPoolId(chainId, stakingContractAddress);

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

  // Mark the tree this root came from as published.
  const publishedTrees = await context.StakingPoolV4RewardTree.getWhere({
    merkleRoot: { _eq: merkleRoot },
    pool_id: { _eq: stakingPool.id },
  });
  for (const tree of publishedTrees) {
    context.StakingPoolV4RewardTree.set({
      ...tree,
      isPublished: true,
      publishedAtTimestamp: timestamp,
      publishedTransactionHash: hash,
      publishedAmount: amount,
    });
  }

  // Fetch all pending cumulative reward records.
  // A pending record has updatedAtTimestamp = 0, meaning it was created
  // by a daily rewards calculation but not yet marked as distributed.
  // - `lastDistributedCumulativeReward` / `lastDistributedMerkleRoot` store the values from the most recent
  // successful distribution for this user. This provides a fallback for the frontend if the latest
  // cumulative reward (from a daily calculation) has not yet been distributed on-chain.
  const pendingRewards = await context.UserCumulativeReward.getWhere({
    updatedAtTimestamp: { _eq: 0 },
    stakingPool_id: { _eq: stakingPool.id },
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

indexer.onEvent({ contract: "UniswapV4Staking", event: "RewardsClaimed" }, ({ event, context }) =>
  recordRewardPayout(event, context, "claimed"),
);

indexer.onEvent({ contract: "UniswapV4Staking", event: "RewardsBurned" }, ({ event, context }) =>
  recordRewardPayout(event, context, "burned"),
);
