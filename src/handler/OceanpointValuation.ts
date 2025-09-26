import { OceanpointValuation } from 'generated';
import { getNewOceanpointTokenInformation } from '../helper/OceanpointTokenValuation';
import { getStakingPoolAddressFromValuationAddress } from '../helper/PropertyStakingPool';
import {BIGINT_100K} from "../helper/constants";

OceanpointValuation.ValuationUpdate.handler(async ({ event, context }) => {
  const stakingPoolAdddress = getStakingPoolAddressFromValuationAddress(
    event.srcAddress
  );

  const valuation = await context.OceanpointTokenInformation.getOrCreate(
    getNewOceanpointTokenInformation(
      event.chainId,
      event.params.property,
      event.srcAddress,
      stakingPoolAdddress
    )
  );

  const valuePerBSPT = event.params.newValuation / BIGINT_100K;

  context.OceanpointTokenInformation.set({
    ...valuation,
    valuation: event.params.newValuation,
    valuationFrom: event.srcAddress,
    valuePerBSPT,
  });
});

OceanpointValuation.APYUpdate.handler(async ({ event, context }) => {
  const stakingPoolAdddress = getStakingPoolAddressFromValuationAddress(
    event.srcAddress
  );

  const valuation = await context.OceanpointTokenInformation.getOrCreate(
    getNewOceanpointTokenInformation(
      event.chainId,
      event.params.property,
      event.srcAddress,
      stakingPoolAdddress
    )
  );

  context.OceanpointTokenInformation.set({
    ...valuation,
    apy: event.params.newAPY,
  });
});
