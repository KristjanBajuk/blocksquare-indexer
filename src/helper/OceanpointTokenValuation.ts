import { OceanpointTokenInformation } from 'generated';

export const getNewOceanpointTokenInformation = (
  chainId: number,
  propertyAddress: string,
  contractAddress: string,
  propertyStakingContractAddress: string
): OceanpointTokenInformation => {
  return {
    id: `${chainId}-${propertyAddress}-${contractAddress}`,
    chainId,
    apy: 0n,
    valuation: 0n,
    valuationFrom: '',
    propertyStakingPool_id: `${chainId}-${propertyStakingContractAddress}`,
    propertyToken_id: `${chainId}-${propertyAddress}`,
    valuePerBSPT: 0n,
  };
};
