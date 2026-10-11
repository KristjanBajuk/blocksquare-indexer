import type {
  EvmEvent,
  EvmOnEventContext,
  StakingPoolV4PositionRecord,
  UniswapV4PositionToken,
  UserCumulativeReward,
} from 'envio';

import { getDay } from './date';
import { StakingPoolV4PositionRecordType } from '../types/enums';

export const getStakingPoolId = (chainId: number, contractAddress: string) =>
  `${chainId}-${contractAddress}`;

/** One staking position per (owner, NFT): a re-deposit by the same owner reopens it. */
export const getStakingPositionId = (chainId: number, owner: string, tokenId: bigint) =>
  `${chainId}-${owner}-${tokenId}`;

type StakingEventMeta = {
  chainId: number;
  logIndex: number;
  block: { number: number; timestamp: number };
  transaction: { hash: string };
};

/**
 * Writes one entry of a token's staking history (deposit, withdrawal, claim or burn).
 * Keyed by (blockNumber, logIndex), which is unique per chain: an hour bucket is not, because
 * logIndex only counts logs within one block.
 */
export const writeStakingHistoryRecord = (
  context: EvmOnEventContext,
  event: StakingEventMeta,
  record: Pick<
    StakingPoolV4PositionRecord,
    'tokenId' | 'epoch' | 'transactionType' | 'pool_id' | 'stakingPosition_id' | 'wallet_id'
  > &
    Partial<Pick<StakingPoolV4PositionRecord, 'rewardsClaimed' | 'rewardsBurned'>>,
) => {
  const {
    chainId,
    logIndex,
    block: { number: blockNumber, timestamp },
    transaction: { hash },
  } = event;
  context.StakingPoolV4PositionRecord.set({
    id: `${record.pool_id}-${record.tokenId}-${blockNumber}-${logIndex}`,
    chainId,
    transactionHash: hash,
    blockNumber,
    blockTimestamp: timestamp,
    dayStartTimestamp: getDay(timestamp).start,
    rewardsClaimed: 0n,
    rewardsBurned: 0n,
    ...record,
  });
};

/**
 * Cumulative rewards belong to one deposit of the NFT, not to the wallet that staked it: every
 * deposit starts a new epoch, the contract verifies leaves of (tokenId, epoch, cumulativeReward)
 * and tracks `totalClaimedRewards[tokenId][epoch]`. Keying the record by (tokenId, epoch) keeps
 * each deposit's total and slash separate, and intact across withdrawals and resales.
 */
export const getRewardRecordId = (chainId: number, tokenId: bigint, epoch: bigint) =>
  `${chainId}-${tokenId}-${epoch}`;

/**
 * A reward record with nothing earned, claimed or burned yet. It gets no leaf until its
 * cumulativeReward is above zero.
 */
export const getNewUserCumulativeReward = ({
  chainId,
  tokenId,
  epoch,
  walletId,
  stakingPoolId,
  uniPositionId,
  blockNumber,
}: {
  chainId: number;
  tokenId: bigint;
  epoch: bigint;
  walletId: string;
  stakingPoolId: string;
  uniPositionId: string;
  blockNumber: number;
}): UserCumulativeReward => ({
  id: getRewardRecordId(chainId, tokenId, epoch),
  tokenId,
  epoch,
  rewardSlash: 0n,
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
 * Resolves who a claim/burn for `tokenId` belongs to. The events only carry the tokenId and epoch,
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
  const stakingPositions = [
    ...(await context.StakingPoolV4Position.getWhere({
      tokenId: { _eq: positionToken.tokenId },
      pool_id: { _eq: stakingPoolId },
    })),
  ].sort((a, b) => b.updatedAtTimestamp - a.updatedAtTimestamp);

  const openPosition = stakingPositions.find((p) => !p.isPositionClosed);
  // The history record links to the position that earned the rewards: the open one, or else the
  // latest closed one. After a resale, a holder who hasn't staked yet (e.g. Dave claiming #44)
  // has no position of their own, so the claim links to the seller's closed position while
  // `walletId` names the holder.
  const stakingPosition = openPosition ?? stakingPositions[0];

  return {
    walletId: openPosition?.wallet_id ?? positionToken.wallet_id,
    stakingPositionId:
      stakingPosition?.id ??
      getStakingPositionId(chainId, positionToken.owner, positionToken.tokenId),
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
 * burn slashes them (early-withdrawal penalty); both reduce what is left to claim for that
 * deposit's (tokenId, epoch) bucket.
 *
 * This:
 * 1. Adds the amount to the staking pool's claimed or burned total.
 * 2. Writes a history record for the claim or burn.
 * 3. Adds the amount to the (tokenId, epoch) reward record and moves it to the current reward owner.
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
    params: { tokenId, epoch, amount },
    srcAddress: stakingContractAddress,
  } = event;
  const { poolTotal, transactionType } = PAYOUT_FIELDS[kind];

  const uniswapV4PositionToken = await context.UniswapV4PositionToken.get(`${chainId}-${tokenId}`);
  if (!uniswapV4PositionToken) return;

  const stakingPool = await context.StakingPoolV4.get(
    getStakingPoolId(chainId, stakingContractAddress),
  );
  if (!stakingPool) return;

  // Rewards are tracked per (tokenId, epoch), like the contract does. The reward owner is resolved
  // from staking state rather than `transaction.from`, which may be a relayer or bundler.
  const { walletId, stakingPositionId } = await resolveRewardOwner(
    context,
    chainId,
    stakingPool.id,
    uniswapV4PositionToken,
  );
  const rewardRecord = await context.UserCumulativeReward.get(
    getRewardRecordId(chainId, tokenId, epoch),
  );

  context.StakingPoolV4.set({
    ...stakingPool,
    [poolTotal]: stakingPool[poolTotal] + amount,
  });

  writeStakingHistoryRecord(context, event, {
    tokenId,
    epoch,
    transactionType,
    pool_id: stakingPool.id,
    stakingPosition_id: stakingPositionId,
    wallet_id: walletId,
    rewardsClaimed: kind === 'claimed' ? amount : 0n,
    rewardsBurned: kind === 'burned' ? amount : 0n,
  });

  const record =
    rewardRecord ??
    getNewUserCumulativeReward({
      chainId,
      tokenId,
      epoch,
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
