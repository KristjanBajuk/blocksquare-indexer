process.env.ENVIO_NETWORK = 'testnet';

import { describe, it, beforeEach } from 'vitest';
import { createTestIndexer, type TestIndexer, type TestIndexerProcessConfig } from 'envio';
import { ZeroAddress } from 'ethers';
import { CHAIN_ID, addr } from './fixtures';

type ChainSimulate = NonNullable<
  NonNullable<TestIndexerProcessConfig['chains'][typeof CHAIN_ID]>['simulate']
>;

// Static BlocksquareToken address from config.yaml (chain 11155111).
const TOKEN_ADDRESS = addr('0x7000Ec7486d8c6f9bd9FfA930f9ACE2D9564d02b');
const DEAD_ADDRESS = addr('0x000000000000000000000000000000000000dEaD');
const ALICE = addr('0x1111111111111111111111111111111111111111');
const BOB = addr('0x2222222222222222222222222222222222222222');

const TOKEN_ID = `${CHAIN_ID}-${TOKEN_ADDRESS}`;
const holderId = (wallet: string) => `${CHAIN_ID}-${TOKEN_ADDRESS}-${wallet}`;

const transferEvent = (
  from: `0x${string}`,
  to: `0x${string}`,
  amount: bigint,
  logIndex = 1,
): ChainSimulate[number] => ({
  contract: 'BlocksquareToken',
  event: 'Transfer',
  srcAddress: TOKEN_ADDRESS,
  logIndex,
  block: { number: 100 + logIndex, timestamp: 1_700_000_000 },
  transaction: { hash: `0x${'ab'.repeat(31)}${logIndex.toString(16).padStart(2, '0')}` },
  params: { _from: from, _to: to, _amount: amount },
});

const runEvents = (indexer: TestIndexer, ...events: ChainSimulate) =>
  indexer.process({ chains: { [CHAIN_ID]: { simulate: events } } });

describe('BlocksquareToken Transfer', () => {
  let indexer: TestIndexer;

  beforeEach(() => {
    indexer = createTestIndexer();
  });

  it('mint creates the token, a holder and history records', async (t) => {
    await runEvents(indexer, transferEvent(ZeroAddress as `0x${string}`, ALICE, 100n));

    const token = await indexer.Token.getOrThrow(TOKEN_ID);
    t.expect(token.totalSupply).toBe(100n);
    t.expect(token.totalTransfers).toBe(1);
    t.expect(token.totalHolders).toBe(1);
    t.expect(token.totalBurnt).toBe(0n);

    const holder = await indexer.TokenHolder.getOrThrow(holderId(ALICE));
    t.expect(holder.amount).toBe(100n);
    t.expect(holder.token_id).toBe(TOKEN_ID);

    const holderRecords = await indexer.TokenHolderRecord.getAll();
    t.expect(holderRecords).toHaveLength(1);
    t.expect(holderRecords[0]?.amount).toBe(100n);
    t.expect(await indexer.TokenRecord.getAll()).toHaveLength(1);
  });

  it('transfer moves balances between holders', async (t) => {
    await runEvents(
      indexer,
      transferEvent(ZeroAddress as `0x${string}`, ALICE, 100n, 1),
      transferEvent(ALICE, BOB, 40n, 2),
    );

    t.expect((await indexer.TokenHolder.getOrThrow(holderId(ALICE))).amount).toBe(60n);
    t.expect((await indexer.TokenHolder.getOrThrow(holderId(BOB))).amount).toBe(40n);
    t.expect((await indexer.Token.getOrThrow(TOKEN_ID)).totalHolders).toBe(2);
  });

  it('full spend removes the sender holder', async (t) => {
    await runEvents(
      indexer,
      transferEvent(ZeroAddress as `0x${string}`, ALICE, 100n, 1),
      transferEvent(ALICE, BOB, 40n, 2),
      transferEvent(ALICE, BOB, 60n, 3),
    );

    t.expect(await indexer.TokenHolder.get(holderId(ALICE))).toBeUndefined();
    t.expect((await indexer.TokenHolder.getOrThrow(holderId(BOB))).amount).toBe(100n);

    const token = await indexer.Token.getOrThrow(TOKEN_ID);
    t.expect(token.totalHolders).toBe(1);
    t.expect(token.totalTransfers).toBe(3);
    t.expect(token.totalSupply).toBe(100n);
  });

  it('burns to zero address reduce supply, dead address only counts as burnt', async (t) => {
    await runEvents(
      indexer,
      transferEvent(ZeroAddress as `0x${string}`, ALICE, 100n, 1),
      transferEvent(ALICE, ZeroAddress as `0x${string}`, 30n, 2),
      transferEvent(ALICE, DEAD_ADDRESS, 20n, 3),
    );

    const token = await indexer.Token.getOrThrow(TOKEN_ID);
    t.expect(token.totalSupply).toBe(70n);
    t.expect(token.totalBurnt).toBe(50n);

    t.expect((await indexer.TokenHolder.getOrThrow(holderId(ALICE))).amount).toBe(50n);
    // Dead address is tracked as a regular holder.
    t.expect((await indexer.TokenHolder.getOrThrow(holderId(DEAD_ADDRESS))).amount).toBe(20n);
    t.expect(token.totalHolders).toBe(2);
  });

  it('zero-amount transfers are ignored', async (t) => {
    await runEvents(indexer, transferEvent(ALICE, BOB, 0n));

    t.expect(await indexer.Token.getAll()).toHaveLength(0);
    t.expect(await indexer.TokenHolder.getAll()).toHaveLength(0);
    t.expect(await indexer.TokenHolderRecord.getAll()).toHaveLength(0);
  });
});
