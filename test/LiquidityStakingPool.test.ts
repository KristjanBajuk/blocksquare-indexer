process.env.ENVIO_NETWORK = 'testnet';

import { describe, it, beforeEach } from 'vitest';
import { createTestIndexer, type TestIndexer, type TestIndexerProcessConfig } from 'envio';
import { CHAIN_ID, addr } from './fixtures';

type ChainSimulate = NonNullable<
  NonNullable<TestIndexerProcessConfig['chains'][typeof CHAIN_ID]>['simulate']
>;

// BST:ETH liquidity staking pool address from config.yaml (chain 11155111)
const POOL_ADDRESS = addr('0x0a654a300eAbDB763d860154bC72C4DD58c64AEF');
const ALICE = addr('0x6666666666666666666666666666666666666666');
const REWARDER = addr('0x9999999999999999999999999999999999999999');

const POOL_ID = `${CHAIN_ID}-${POOL_ADDRESS}`;
const ALICE_POSITION_ID = `${CHAIN_ID}-${POOL_ADDRESS}-${ALICE}`;
const TIMESTAMP = 1_700_000_000;
const LOCKED_UNTIL = 1_800_000_000n;

const base = (logIndex: number) => ({
  contract: 'LiquidityStakingPool' as const,
  srcAddress: POOL_ADDRESS,
  logIndex,
  block: { number: 100, timestamp: TIMESTAMP },
  transaction: { hash: `0x${'cd'.repeat(31)}${logIndex.toString(16).padStart(2, '0')}` },
});

const depositEvent = (
  owner: `0x${string}`,
  inAmount: bigint,
  outAmount: bigint,
  logIndex = 1,
): ChainSimulate[number] => ({
  ...base(logIndex),
  event: 'Deposit',
  params: { owner, inAmount, outAmount, lockedUntil: LOCKED_UNTIL },
});

const withdrawEvent = (
  owner: `0x${string}`,
  inAmount: bigint,
  outAmount: bigint,
  logIndex = 1,
): ChainSimulate[number] => ({
  ...base(logIndex),
  event: 'Withdraw',
  params: { owner, inAmount, outAmount, reward: 0n },
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

describe('LiquidityStakingPool', () => {
  let indexer: TestIndexer;

  beforeEach(() => {
    indexer = createTestIndexer();
  });

  it('deposit creates pool and position honoring the explicit lockedUntil', async (t) => {
    await runEvents(indexer, depositEvent(ALICE, 100n, 100n));

    const pool = await indexer.StakingPool.getOrThrow(POOL_ID);
    t.expect(pool.currentAmount).toBe(100n);
    t.expect(pool.issuedAmount).toBe(100n);
    t.expect(pool.totalDepositAmount).toBe(100n);

    const position = await indexer.StakingPoolPosition.getOrThrow(ALICE_POSITION_ID);
    t.expect(position.stakedAmount).toBe(100n);
    t.expect(position.issuedAmount).toBe(100n);
    // LiquidityStakingPool Deposit carries lockedUntil, so no 2-day default applies
    t.expect(position.lockedUntil).toBe(Number(LOCKED_UNTIL));

    const txs = await indexer.StakingPoolTransaction.getAll();
    t.expect(txs).toHaveLength(1);
    t.expect(txs[0]?.transactionType).toBe('DEPOSIT');
  });

  it('reward grows the pool and the next deposit snapshots the increased ratio', async (t) => {
    await runEvents(
      indexer,
      depositEvent(ALICE, 100n, 100n, 1),
      rewardEvent(REWARDER, 50n, 2),
      depositEvent(ALICE, 30n, 20n, 3),
    );

    const pool = await indexer.StakingPool.getOrThrow(POOL_ID);
    t.expect(pool.totalRewards).toBe(50n);
    t.expect(pool.currentAmount).toBe(180n);
    t.expect(pool.issuedAmount).toBe(120n);
    // Ratio is computed from the pool state before the last deposit: 150 / 100
    t.expect(pool.ratio.toString()).toBe('1.5');

    const position = await indexer.StakingPoolPosition.getOrThrow(ALICE_POSITION_ID);
    t.expect(position.issuedAmount).toBe(120n);
    t.expect(position.stakedAmount).toBe(130n);
  });

  it('full withdraw empties the pool and deletes the position', async (t) => {
    await runEvents(
      indexer,
      depositEvent(ALICE, 100n, 100n, 1),
      withdrawEvent(ALICE, 100n, 100n, 2),
    );

    const pool = await indexer.StakingPool.getOrThrow(POOL_ID);
    t.expect(pool.currentAmount).toBe(0n);
    t.expect(pool.issuedAmount).toBe(0n);
    t.expect(pool.totalWithdrawAmount).toBe(100n);

    t.expect(await indexer.StakingPoolPosition.getAll()).toHaveLength(0);

    const withdrawTx = (await indexer.StakingPoolTransaction.getAll()).find(
      (tx) => tx.transactionType === 'WITHDRAW',
    );
    t.expect(withdrawTx?.amount).toBe(100n);
  });
});
