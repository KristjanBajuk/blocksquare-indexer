process.env.ENVIO_NETWORK = 'testnet';

import { describe, it, beforeEach } from 'vitest';
import { createTestIndexer, type TestIndexer, type TestIndexerProcessConfig } from 'envio';
import { ZeroAddress } from 'ethers';
import { CHAIN_ID, addr } from './fixtures';

type ChainSimulate = NonNullable<
  NonNullable<TestIndexerProcessConfig['chains'][typeof CHAIN_ID]>['simulate']
>;

// Static GovernancePool address from config.yaml (chain 11155111)
const POOL_ADDRESS = addr('0x145a6DB84aEd0Fe46E4cCB3f96930100418f00A2');
const ALICE = addr('0x6666666666666666666666666666666666666666');
const BOB = addr('0x7777777777777777777777777777777777777777');
const REWARDER = addr('0x9999999999999999999999999999999999999999');

const POOL_ID = `${CHAIN_ID}-${POOL_ADDRESS}`;
const ALICE_POSITION_ID = `${CHAIN_ID}-${POOL_ADDRESS}-${ALICE}`;
const BOB_POSITION_ID = `${CHAIN_ID}-${POOL_ADDRESS}-${BOB}`;
const TIMESTAMP = 1_700_000_000;
const TWO_DAYS = 2 * 24 * 60 * 60;

const base = (logIndex: number) => ({
  contract: 'GovernancePool' as const,
  srcAddress: POOL_ADDRESS,
  logIndex,
  block: { number: 100, timestamp: TIMESTAMP },
  transaction: { hash: `0x${'ab'.repeat(31)}${logIndex.toString(16).padStart(2, '0')}` },
});

const depositEvent = (
  owner: `0x${string}`,
  inAmount: bigint,
  outAmount: bigint,
  logIndex = 1,
): ChainSimulate[number] => ({
  ...base(logIndex),
  event: 'Deposit',
  params: { owner, inAmount, outAmount },
});

const withdrawEvent = (
  owner: `0x${string}`,
  inAmount: bigint,
  outAmount: bigint,
  logIndex = 1,
): ChainSimulate[number] => ({
  ...base(logIndex),
  event: 'Withdraw',
  params: { owner, inAmount, outAmount },
});

const transferEvent = (
  from: `0x${string}`,
  to: `0x${string}`,
  value: bigint,
  logIndex = 1,
): ChainSimulate[number] => ({
  ...base(logIndex),
  event: 'Transfer',
  params: { from, to, value },
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

describe('GovernancePool', () => {
  let indexer: TestIndexer;

  beforeEach(() => {
    indexer = createTestIndexer();
  });

  it('deposit creates pool, position, records and transaction', async (t) => {
    await runEvents(indexer, depositEvent(ALICE, 100n, 100n));

    const pool = await indexer.StakingPool.getOrThrow(POOL_ID);
    t.expect(pool.currentAmount).toBe(100n);
    t.expect(pool.issuedAmount).toBe(100n);
    t.expect(pool.stakedAmount).toBe(100n);
    t.expect(pool.totalDepositAmount).toBe(100n);
    t.expect(pool.ratio.toString()).toBe('1');

    const position = await indexer.StakingPoolPosition.getOrThrow(ALICE_POSITION_ID);
    t.expect(position.issuedAmount).toBe(100n);
    t.expect(position.stakedAmount).toBe(100n);
    t.expect(position.lockedUntil).toBe(TIMESTAMP + TWO_DAYS);
    t.expect(position.wallet_id).toBe(`${CHAIN_ID}-${ALICE}`);

    t.expect(await indexer.Wallet.get(`${CHAIN_ID}-${ALICE}`)).toBeDefined();
    t.expect(await indexer.StakingPoolRecord.getAll()).toHaveLength(1);

    const positionRecords = await indexer.StakingPoolPositionRecord.getAll();
    t.expect(positionRecords).toHaveLength(1);
    t.expect(positionRecords[0]?.issuedAmount).toBe(100n);

    const txs = await indexer.StakingPoolTransaction.getAll();
    t.expect(txs).toHaveLength(1);
    t.expect(txs[0]?.transactionType).toBe('DEPOSIT');
    t.expect(txs[0]?.amount).toBe(100n);
  });

  it('partial withdraw reduces pool and position balances', async (t) => {
    await runEvents(indexer, depositEvent(ALICE, 100n, 100n, 1), withdrawEvent(ALICE, 40n, 40n, 2));

    const pool = await indexer.StakingPool.getOrThrow(POOL_ID);
    t.expect(pool.currentAmount).toBe(60n);
    t.expect(pool.issuedAmount).toBe(60n);
    t.expect(pool.totalWithdrawAmount).toBe(40n);
    t.expect(pool.totalDepositAmount).toBe(100n);

    const position = await indexer.StakingPoolPosition.getOrThrow(ALICE_POSITION_ID);
    t.expect(position.issuedAmount).toBe(60n);
    t.expect(position.stakedAmount).toBe(60n);

    const withdrawTx = (await indexer.StakingPoolTransaction.getAll()).find(
      (tx) => tx.transactionType === 'WITHDRAW',
    );
    t.expect(withdrawTx?.amount).toBe(40n);
    t.expect(withdrawTx?.issuedAmount).toBe(40n);
  });

  it('full withdraw deletes the position and zero-amount withdraws are ignored', async (t) => {
    await runEvents(
      indexer,
      withdrawEvent(ALICE, 0n, 0n, 1), // ignored, would otherwise throw (no pool yet)
      depositEvent(ALICE, 100n, 100n, 2),
      withdrawEvent(ALICE, 100n, 100n, 3),
    );

    const pool = await indexer.StakingPool.getOrThrow(POOL_ID);
    t.expect(pool.currentAmount).toBe(0n);
    t.expect(pool.issuedAmount).toBe(0n);
    t.expect(pool.totalWithdrawAmount).toBe(100n);

    t.expect(await indexer.StakingPoolPosition.getAll()).toHaveLength(0);

    // Only deposit + full withdraw produced transactions
    t.expect(await indexer.StakingPoolTransaction.getAll()).toHaveLength(2);

    const positionRecords = await indexer.StakingPoolPositionRecord.getAll();
    t.expect(positionRecords).toHaveLength(2);
    const finalRecord = positionRecords.find((r) => r.transactionHash.endsWith('03'));
    t.expect(finalRecord?.issuedAmount).toBe(0n);
  });

  it('transfer moves issued amount to a new position, skipping zero-value and zero-address', async (t) => {
    await runEvents(
      indexer,
      depositEvent(ALICE, 100n, 100n, 1),
      transferEvent(ALICE, BOB, 40n, 2),
      transferEvent(ALICE, BOB, 0n, 3), // skipped
      transferEvent(ZeroAddress as `0x${string}`, BOB, 10n, 4), // skipped (mint handled by Deposit)
    );

    const alice = await indexer.StakingPoolPosition.getOrThrow(ALICE_POSITION_ID);
    t.expect(alice.issuedAmount).toBe(60n);
    t.expect(alice.stakedAmount).toBe(100n); // transfer does not touch stakedAmount

    const bob = await indexer.StakingPoolPosition.getOrThrow(BOB_POSITION_ID);
    t.expect(bob.issuedAmount).toBe(40n);
    t.expect(bob.stakedAmount).toBe(0n);
    t.expect(await indexer.Wallet.get(`${CHAIN_ID}-${BOB}`)).toBeDefined();

    // 1 deposit record + 2 transfer records (from + to)
    t.expect(await indexer.StakingPoolPositionRecord.getAll()).toHaveLength(3);
  });

  it('reward increases current amount and total rewards', async (t) => {
    await runEvents(indexer, depositEvent(ALICE, 100n, 100n, 1), rewardEvent(REWARDER, 50n, 2));

    const pool = await indexer.StakingPool.getOrThrow(POOL_ID);
    t.expect(pool.currentAmount).toBe(150n);
    t.expect(pool.totalRewards).toBe(50n);
    t.expect(pool.issuedAmount).toBe(100n);

    const rewardTx = (await indexer.StakingPoolTransaction.getAll()).find(
      (tx) => tx.transactionType === 'REWARD',
    );
    t.expect(rewardTx?.amount).toBe(50n);
    t.expect(rewardTx?.wallet_id).toBe(`${CHAIN_ID}-${REWARDER}`);
  });
});
