import { LiquidityStakingPool } from 'generated';
import {
  StakingDepositHandler,
  StakingWithdrawHandler,
  StakingRewardHandler,
} from '../helper/StakingPool';

LiquidityStakingPool.Deposit.handler(async ({ event, context }) => {
  await StakingDepositHandler(event, context);
});

LiquidityStakingPool.Withdraw.handler(async ({ event, context }) => {
  await StakingWithdrawHandler(event, context);
});

LiquidityStakingPool.Reward.handler(async ({ event, context }) => {
  await StakingRewardHandler(event, context);
});
