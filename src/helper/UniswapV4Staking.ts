import type {
  EvmEvent,
  EvmOnEventContext,
  UniswapV4PositionToken,
  UserCumulativeReward,
} from 'envio';

import { getDay, getHour } from './date';
import { StakingPoolV4PositionRecordType } from '../types/enums';

/**
 * Cumulative rewards belong to the NFT, not to the wallet that staked it: the contract
 * verifies leaves of (tokenId, cumulativeReward) and tracks `totalClaimedRewards[tokenId]`.
 * Keying the record by tokenId keeps the total intact across withdrawals and resales.
 */
export const getRewardRecordId = (chainId: number, tokenId: bigint) => `${chainId}-${tokenId}`;

/**
 * A reward record with nothing earned, claimed or burned yet. It gets no leaf until its
 * cumulativeReward is above zero.
 */
export const getNewUserCumulativeReward = ({
  chainId,
  tokenId,
  walletId,
  stakingPoolId,
  uniPositionId,
  blockNumber,
}: {
  chainId: number;
  tokenId: bigint;
  walletId: string;
  stakingPoolId: string;
  uniPositionId: string;
  blockNumber: number;
}): UserCumulativeReward => ({
  id: getRewardRecordId(chainId, tokenId),
  tokenId,
  cumulativeReward: 0n,
  claimed: 0n,
  burned: 0n,
  lastDistributedCumulativeReward: 0n,
  updatedAtTimestamp: 0,
  blockNumber,
  merkleRoot: '',
  proof: [],
  lastDistributedProof: [],
  lastDistributedMerkleRoot: '',
  isRewardsDistributed: false,
  distributionSkipped: false,
  wallet_id: walletId,
  stakingPool_id: stakingPoolId,
  uniPosition_id: uniPositionId,
});

/**
 * Resolves who a claim/burn for `tokenId` belongs to. The events only carry the tokenId,
 * and `transaction.from` can be a relayer or bundler, so it cannot be used.
 * - Staked: the staker of the open position.
 * - Unstaked: the current NFT holder; the history record links the latest closed position.
 */
export const resolveRewardOwner = async (
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

const PAYOUT_FIELDS = {
  claimed: {
    poolTotal: 'totalRewardsClaimed',
    transactionType: StakingPoolV4PositionRecordType.REWARDS_CLAIMED,
  },
  burned: {
    poolTotal: 'totalRewardsBurned',
    transactionType: StakingPoolV4PositionRecordType.REWARDS_BURNED,
  },
} as const;

/**
 * Shared body of the RewardsClaimed and RewardsBurned handlers. A claim pays rewards out and a
 * burn slashes them (early-withdrawal penalty); both reduce what is left to claim for the NFT.
 *
 * This:
 * 1. Adds the amount to the staking pool's claimed or burned total.
 * 2. Writes a history record for the claim or burn.
 * 3. Adds the amount to the NFT's reward record and moves it to the current reward owner.
 */
export const recordRewardPayout = async (
  event:
    | EvmEvent<'UniswapV4Staking', 'RewardsClaimed'>
    | EvmEvent<'UniswapV4Staking', 'RewardsBurned'>,
  context: EvmOnEventContext,
  kind: 'claimed' | 'burned',
) => {
  const {
    chainId,
    block: { timestamp, number: blockNumber },
    params: { tokenId, amount },
    srcAddress: stakingContractAddress,
    transaction: { hash },
    logIndex,
  } = event;
  const { poolTotal, transactionType } = PAYOUT_FIELDS[kind];

  const { id: hourId } = getHour(timestamp);
  const { start: dayStart } = getDay(timestamp);

  const uniswapV4PositionToken = await context.UniswapV4PositionToken.get(`${chainId}-${tokenId}`);
  if (!uniswapV4PositionToken) return;

  const stakingPool = await context.StakingPoolV4.get(`${chainId}-${stakingContractAddress}`);
  if (!stakingPool) return;

  // Rewards are tracked per tokenId, like the contract does. The reward owner is resolved
  // from staking state rather than `transaction.from`, which may be a relayer or bundler.
  const { walletId, stakingPositionId } = await resolveRewardOwner(
    context,
    chainId,
    stakingPool.id,
    uniswapV4PositionToken,
  );
  const rewardRecord = await context.UserCumulativeReward.get(getRewardRecordId(chainId, tokenId));

  context.StakingPoolV4.set({
    ...stakingPool,
    [poolTotal]: stakingPool[poolTotal] + amount,
  });

  context.StakingPoolV4PositionRecord.set({
    id: `${stakingPool.id}-${uniswapV4PositionToken.tokenId}-${hourId}-${logIndex}`,
    chainId,
    dayStartTimestamp: dayStart,
    blockTimestamp: timestamp,
    blockNumber,
    pool_id: stakingPool.id,
    rewardsClaimed: kind === 'claimed' ? amount : 0n,
    rewardsBurned: kind === 'burned' ? amount : 0n,
    transactionHash: hash,
    tokenId: uniswapV4PositionToken.tokenId,
    transactionType,
    stakingPosition_id: stakingPositionId,
    wallet_id: walletId,
  });

  const record =
    rewardRecord ??
    getNewUserCumulativeReward({
      chainId,
      tokenId,
      walletId,
      stakingPoolId: stakingPool.id,
      uniPositionId: uniswapV4PositionToken.position_id,
      blockNumber: 0,
    });
  context.UserCumulativeReward.set({
    ...record,
    [kind]: record[kind] + amount,
    // The record follows the current owner, e.g. a buyer claiming before staking.
    wallet_id: walletId,
  });
};
