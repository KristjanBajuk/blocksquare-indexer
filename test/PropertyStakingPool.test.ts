process.env.ENVIO_NETWORK = 'testnet';

import { describe, it, beforeEach } from 'vitest';
import { createTestIndexer, type TestIndexer, type TestIndexerProcessConfig } from 'envio';
import { CHAIN_ID, addr } from './fixtures';

type ChainSimulate = NonNullable<
  NonNullable<TestIndexerProcessConfig['chains'][typeof CHAIN_ID]>['simulate']
>;

// Community staking pool + its valuation address from src/config/testnet.ts
const POOL_ADDRESS = addr('0x9CaE63f8e6b931D269A449A937F742a5d1B3A4A9');
const VALUATION_ADDRESS = addr('0x00e63d90b0481c8AC9abE68d03ec40B2d3e87E45');
const PROPERTY = addr('0x1111111111111111111111111111111111111111');
const ALICE = addr('0x6666666666666666666666666666666666666666');
const REWARDER = addr('0x9999999999999999999999999999999999999999');

const POOL_ID = `${CHAIN_ID}-${POOL_ADDRESS}`;
const TOKEN_INFO_ID = `${CHAIN_ID}-${PROPERTY}-${VALUATION_ADDRESS}`;
const ALICE_POSITION_ID = `${CHAIN_ID}-${ALICE}-${POOL_ADDRESS}`;
const TIMESTAMP = 1_700_000_000;
const WEI = 10n ** 18n;
// valuation / 100_000 => valuePerBSPT of exactly 1e18, so depositValue == inAmount
const VALUATION = 100_000n * WEI;

const base = (logIndex: number) => ({
  contract: 'PropertyStakingPool' as const,
  srcAddress: POOL_ADDRESS,
  logIndex,
  block: { number: 100, timestamp: TIMESTAMP },
  transaction: { hash: `0x${'ef'.repeat(31)}${logIndex.toString(16).padStart(2, '0')}` },
});

const depositEvent = (
  owner: `0x${string}`,
  inAmount: bigint,
  outAmount: bigint,
  logIndex = 1,
): ChainSimulate[number] => ({
  ...base(logIndex),
  event: 'Deposit',
  params: { owner, property: PROPERTY, inAmount, outAmount, lockedUntil: 1_800_000_000n },
});

const withdrawEvent = (
  owner: `0x${string}`,
  inAmount: bigint,
  outAmount: bigint,
  rewardToUser: bigint,
  rewardToFeeReciever: bigint,
  logIndex = 1,
): ChainSimulate[number] => ({
  ...base(logIndex),
  event: 'Withdraw',
  params: {
    owner,
    property: PROPERTY,
    inAmount,
    outAmount,
    rewardToUser,
    rewardToFeeReciever,
    isWithdraw: true,
  },
});

const rewardEvent = (
  from: `0x${string}`,
  amount: bigint,
  logIndex = 1,
): ChainSimulate[number] => ({
  ...base(logIndex),
  event: 'Reward',
  params: { from, amount },
});

const runEvents = (indexer: TestIndexer, ...events: ChainSimulate) =>
  indexer.process({ chains: { [CHAIN_ID]: { simulate: events } } });

describe('PropertyStakingPool', () => {
  let indexer: TestIndexer;

  beforeEach(() => {
    indexer = createTestIndexer();
    indexer.OceanpointTokenInformation.set({
      id: TOKEN_INFO_ID,
      chainId: CHAIN_ID,
      propertyToken_id: `${CHAIN_ID}-${PROPERTY}`,
      propertyStakingPool_id: POOL_ID,
      propertyStakingPoolType: 'COMMUNITY',
      valuation: VALUATION,
      valuationFrom: VALUATION_ADDRESS,
      valuePerBSPT: WEI,
      apy: 0n,
    });
  });

  it('deposit creates pool, position, token deposit and transaction', async (t) => {
    await runEvents(indexer, depositEvent(ALICE, 100n, 100n));

    const pool = await indexer.PropertyStakingPool.getOrThrow(POOL_ID);
    t.expect(pool.currentAmount).toBe(100n);
    t.expect(pool.issuedAmount).toBe(100n);
    t.expect(pool.tvl).toBe(100n);

    const position = await indexer.PropertyStakingPoolPosition.getOrThrow(ALICE_POSITION_ID);
    t.expect(position.totalIssuedAmount).toBe(100n);
    t.expect(position.totalStakedAmount).toBe(100n);
    t.expect(position.totalStakedValue).toBe(100n);
    t.expect(position.tokenInformation_id).toBe(TOKEN_INFO_ID);
    t.expect(await indexer.Wallet.get(`${CHAIN_ID}-${ALICE}`)).toBeDefined();

    const deposit = await indexer.TokenDeposit.getOrThrow(`${ALICE_POSITION_ID}-${TOKEN_INFO_ID}`);
    t.expect(deposit.stakedAmount).toBe(100n);
    t.expect(deposit.issuedAmount).toBe(100n);
    t.expect(deposit.lockedUntil).toBe(1_800_000_000);
    t.expect(deposit.valuePerBSPT).toBe(WEI);
    t.expect(deposit.stakedValue).toBe(100n);

    t.expect(await indexer.PropertyStakingPoolRecord.getAll()).toHaveLength(1);
    const txs = await indexer.PropertyStakingPoolTransaction.getAll();
    t.expect(txs).toHaveLength(1);
    t.expect(txs[0]?.transactionType).toBe('DEPOSIT');
    t.expect(txs[0]?.tokenAddress).toBe(PROPERTY);
  });

  it('withdraw pays out rewards and removes position and token deposit', async (t) => {
    await runEvents(
      indexer,
      depositEvent(ALICE, 100n, 100n, 1),
      rewardEvent(REWARDER, 10n, 2),
      withdrawEvent(ALICE, 100n, 100n, 5n, 1n, 3),
    );

    const pool = await indexer.PropertyStakingPool.getOrThrow(POOL_ID);
    t.expect(pool.currentAmount).toBe(0n);
    t.expect(pool.issuedAmount).toBe(0n);
    t.expect(pool.totalRewards).toBe(10n);
    t.expect(pool.totalRewardsPaid).toBe(6n);
    t.expect(pool.currentRewards).toBe(4n);
    t.expect(pool.tvl).toBe(0n);

    t.expect(await indexer.PropertyStakingPoolPosition.getAll()).toHaveLength(0);
    t.expect(await indexer.TokenDeposit.getAll()).toHaveLength(0);

    const withdrawTx = (await indexer.PropertyStakingPoolTransaction.getAll()).find(
      (tx) => tx.transactionType === 'WITHDRAW',
    );
    t.expect(withdrawTx?.amount).toBe(100n);
    t.expect(withdrawTx?.rewardToUser).toBe(5n);
    t.expect(withdrawTx?.rewardToFeeReceiver).toBe(1n);
  });

  it('zero-amount withdraw is ignored', async (t) => {
    await runEvents(indexer, withdrawEvent(ALICE, 0n, 0n, 0n, 0n));

    t.expect(await indexer.PropertyStakingPool.getAll()).toHaveLength(0);
    t.expect(await indexer.PropertyStakingPoolTransaction.getAll()).toHaveLength(0);
  });

  it('reward creates the pool when missing and tracks reward totals', async (t) => {
    await runEvents(indexer, rewardEvent(REWARDER, 25n));

    const pool = await indexer.PropertyStakingPool.getOrThrow(POOL_ID);
    t.expect(pool.totalRewards).toBe(25n);
    t.expect(pool.currentRewards).toBe(25n);
    t.expect(pool.currentAmount).toBe(0n);

    const txs = await indexer.PropertyStakingPoolTransaction.getAll();
    t.expect(txs).toHaveLength(1);
    t.expect(txs[0]?.transactionType).toBe('REWARD');
    t.expect(txs[0]?.wallet_id).toBe(`${CHAIN_ID}-${REWARDER}`);
  });
});
