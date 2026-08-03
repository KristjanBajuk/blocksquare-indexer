process.env.ENVIO_NETWORK = 'testnet';

import { describe, it, beforeEach } from 'vitest';
import { createTestIndexer, type TestIndexer, type TestIndexerProcessConfig } from 'envio';
import { ZeroAddress } from 'ethers';
import { CHAIN_ID, addr } from './fixtures';

type ChainSimulate = NonNullable<
  NonNullable<TestIndexerProcessConfig['chains'][typeof CHAIN_ID]>['simulate']
>;

const TOKEN_ADDRESS = addr('0x5555555555555555555555555555555555555555');
const CP_WALLET_ADDRESS = addr('0x8888888888888888888888888888888888888888');
const ALICE = addr('0x6666666666666666666666666666666666666666');
const BOB = addr('0x7777777777777777777777777777777777777777');

const TOKEN_ID = `${CHAIN_ID}-${TOKEN_ADDRESS}`;

// Registers TOKEN_ADDRESS via contractRegister and creates the PropertyToken entity.
const newPropTokenEvent = (): ChainSimulate[number] => ({
  contract: 'PropertyFactory',
  event: 'NewPropToken',
  logIndex: 1,
  block: { number: 99, timestamp: 1_699_999_000 },
  transaction: { hash: `0x${'aa'.repeat(32)}` },
  params: { certifiedPartner: CP_WALLET_ADDRESS, proptoken: TOKEN_ADDRESS, createdAt: 0n },
});

const transferEvent = (
  from: `0x${string}`,
  to: `0x${string}`,
  value: bigint,
  logIndex = 1,
): ChainSimulate[number] => ({
  contract: 'PropertyToken',
  event: 'Transfer',
  srcAddress: TOKEN_ADDRESS,
  logIndex,
  block: { number: 100, timestamp: 1_700_000_000 },
  transaction: { hash: `0x${'ef'.repeat(31)}${logIndex.toString(16).padStart(2, '0')}`, transactionIndex: 0 },
  params: { from, to, value },
});

const runEvents = (indexer: TestIndexer, ...events: ChainSimulate) =>
  indexer.process({ chains: { [CHAIN_ID]: { simulate: [newPropTokenEvent(), ...events] } } });

describe('PropertyToken Transfer', () => {
  let indexer: TestIndexer;

  beforeEach(() => {
    indexer = createTestIndexer();
    indexer.Wallet.set({
      id: `${CHAIN_ID}-${CP_WALLET_ADDRESS}`,
      address: CP_WALLET_ADDRESS,
      chainId: CHAIN_ID,
      user_id: undefined,
      certifiedPartner_id: `${CHAIN_ID}-cp1`,
    });
  });

  it('mint updates state and writes a transfer history entry', async (t) => {
    await runEvents(indexer, transferEvent(ZeroAddress as `0x${string}`, ALICE, 100n));

    const token = await indexer.PropertyToken.getOrThrow(TOKEN_ID);
    t.expect(token.totalSupply).toBe(100n);
    t.expect(token.totalTransfers).toBe(1);
    t.expect(token.totalHolders).toBe(1);

    const holder = await indexer.PropertyTokenHolder.getOrThrow(`${CHAIN_ID}-${TOKEN_ADDRESS}-${ALICE}`);
    t.expect(holder.amount).toBe(100n);

    const transfers = await indexer.PropertyTokenTransfer.getAll();
    t.expect(transfers).toHaveLength(1);
    t.expect(transfers[0]?.amount).toBe(100n);
    t.expect(transfers[0]?.from_id).toBe(`${CHAIN_ID}-${ZeroAddress}`);
    t.expect(transfers[0]?.to_id).toBe(`${CHAIN_ID}-${ALICE}`);
  });

  it('wallet-to-wallet transfer moves balances and logs history', async (t) => {
    await runEvents(
      indexer,
      transferEvent(ZeroAddress as `0x${string}`, ALICE, 100n, 1),
      transferEvent(ALICE, BOB, 40n, 2),
    );

    const alice = await indexer.PropertyTokenHolder.getOrThrow(`${CHAIN_ID}-${TOKEN_ADDRESS}-${ALICE}`);
    const bob = await indexer.PropertyTokenHolder.getOrThrow(`${CHAIN_ID}-${TOKEN_ADDRESS}-${BOB}`);
    t.expect(alice.amount).toBe(60n);
    t.expect(bob.amount).toBe(40n);

    const token = await indexer.PropertyToken.getOrThrow(TOKEN_ID);
    t.expect(token.totalTransfers).toBe(2);
    t.expect(token.totalHolders).toBe(2);
    t.expect(await indexer.PropertyTokenTransfer.getAll()).toHaveLength(2);
  });

  it('zero-value transfers are ignored by both handlers', async (t) => {
    await runEvents(indexer, transferEvent(ALICE, BOB, 0n));

    const token = await indexer.PropertyToken.getOrThrow(TOKEN_ID);
    t.expect(token.totalTransfers).toBe(0);
    t.expect(await indexer.PropertyTokenTransfer.getAll()).toHaveLength(0);
  });
});
