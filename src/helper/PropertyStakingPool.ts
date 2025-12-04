import { getAddress } from 'ethers';
import {
  BigDecimal,
  PropertyStakingPoolPosition,
  PropertyStakingPoolRecord,
  TokenDeposit,
} from 'generated';

import { getDay, getHour } from './date';
import { getLoadedConfig } from '../config';
import { PropertyStakingPool } from 'generated/src/Types.gen';
import { PropertyStakingPoolType } from '../types/enums';
export const getNewPropertyStakingPool = (
  chainId: number,
  poolId: string
): PropertyStakingPool => {
  return {
    id: `${chainId}-${poolId}`,
    chainId,
    issuedAmount: 0n,
    currentAmount: 0n,
    totalRewards: 0n,
    totalRewardsPaid: 0n,
    currentRewards: 0n,
    tvl: 0n,
  };
};

export const getNewTokenDeposit = (
    stakingPoolPositionId: string,
    tokenInformationId: string
): TokenDeposit => {
  return {
    id: `${stakingPoolPositionId}-${tokenInformationId}`,
    stakingPoolPosition_id: stakingPoolPositionId,
    tokenInformation_id: tokenInformationId,
    stakedAmount: 0n,
    lockedUntil: 0,
    valuePerBSPT: 0n,
    issuedAmount: 0n,
    stakedValue: 0n,
  };
};


export const getNewPropertyStakingPoolPosition = (
  chainId: number,
  walletAddress: string,
  poolAddress: string,
  tokenInformationId: string
): PropertyStakingPoolPosition => {
  return {
    id: `${chainId}-${walletAddress}-${poolAddress}`,
    chainId,
    totalIssuedAmount: 0n,
    totalStakedAmount: 0n,
    tokenInformation_id: tokenInformationId,
    wallet_id: `${chainId}-${walletAddress}`,
    pool_id: `${chainId}-${poolAddress}`,
    totalStakedValue: 0n,
  };
};

export const calculatePropertyPoolRatio = (
  pool: PropertyStakingPool
): BigDecimal => {
  if (pool.issuedAmount === 0n) return BigDecimal(1);

  const ratio = BigDecimal(pool.currentAmount.toString()).div(
    pool.issuedAmount.toString()
  );

  return ratio;
};

export const getPropertyStakingPoolRecord = (
  pool: PropertyStakingPool,
  timestamp: number
): PropertyStakingPoolRecord => {
  const { id: hourId, start: hourStart } = getHour(timestamp);
  const { start: dayStart } = getDay(timestamp);

  return {
    id: `${pool.id}-${hourId}`,
    chainId: pool.chainId,
    hourStartTimestamp: hourStart,
    dayStartTimestamp: dayStart,
    issuedAmount: pool.issuedAmount,
    currentAmount: pool.currentAmount,
    totalRewards: pool.totalRewards,
    totalRewardsPaid: pool.totalRewardsPaid,
    currentRewards: pool.currentRewards,
    pool_id: pool.id,
    tvl: pool.tvl,
  };
};

export function getValuationAddressForPropertyStakingPool(
  poolAddress: string
): string {
  const poolAddressFormatted = getAddress(poolAddress);

  const valuationAddress = getLoadedConfig().propertyStakingContracts.find(
    (contract) => contract.address === poolAddressFormatted
  )?.valuationAddress;

  if (!valuationAddress) throw new Error('Valuation address not found');

  return valuationAddress;
}

export function getStakingPoolAddressFromValuationAddress(
  valuationAddress: string
): string {
  const valuationAddressFormatted = getAddress(valuationAddress);

  const stakingPoolAddress = getLoadedConfig().propertyStakingContracts.find(
    (contract) => contract.valuationAddress === valuationAddressFormatted
  )?.address;

  if (!stakingPoolAddress) throw new Error('Staking pool address not found');

  return stakingPoolAddress;
}

export function getStakingPoolTypeFromValuationAddress(
    valuationAddress: string
): PropertyStakingPoolType {
    const valuationAddressFormatted = getAddress(valuationAddress);

    const stakingPoolType = getLoadedConfig().propertyStakingContracts.find(
        (contract) => contract.valuationAddress === valuationAddressFormatted
    )?.type;

    if (!stakingPoolType) throw new Error('Staking pool type not found');

    return stakingPoolType;
}