process.env.ENVIO_NETWORK = 'testnet';

import { describe, it, beforeEach } from 'vitest';
import { createTestIndexer, type TestIndexer, type TestIndexerProcessConfig } from 'envio';
import { CHAIN_ID, addr } from './fixtures';

type ChainSimulate = NonNullable<
  NonNullable<TestIndexerProcessConfig['chains'][typeof CHAIN_ID]>['simulate']
>;

// Static Users contract address from config.yaml (chain 11155111).
const USERS_ADDRESS = addr('0xCd0c1845552DD0b2EFCBa0cF0ECd341A0B99d49a');
const WALLET_A = addr('0x1111111111111111111111111111111111111111');
const USER_STRING = 'aa'.repeat(32);
const OTHER_USER_STRING = 'bb'.repeat(32);

const USER_ID = `${CHAIN_ID}-${USER_STRING}`;
const WALLET_ID = `${CHAIN_ID}-${WALLET_A}`;

let logIndex = 0;
const baseEvent = () => {
  logIndex += 1;
  return {
    contract: 'Users' as const,
    srcAddress: USERS_ADDRESS,
    logIndex,
    block: { number: 100 + logIndex, timestamp: 1_700_000_000 },
    transaction: { hash: `0x${'cd'.repeat(31)}${logIndex.toString(16).padStart(2, '0')}` },
  };
};

const addedWalletEvent = (wallet: `0x${string}`, user = USER_STRING): ChainSimulate[number] => ({
  ...baseEvent(),
  event: 'AddedWallet',
  params: { userBytes: `0x${user}`, wallet, user },
});

const removedWalletEvent = (wallet: `0x${string}`, user = USER_STRING): ChainSimulate[number] => ({
  ...baseEvent(),
  event: 'RemovedWallet',
  params: { userBytes: `0x${user}`, wallet },
});

const runEvents = (indexer: TestIndexer, ...events: ChainSimulate) =>
  indexer.process({ chains: { [CHAIN_ID]: { simulate: events } } });

describe('Users wallet linking', () => {
  let indexer: TestIndexer;

  beforeEach(() => {
    indexer = createTestIndexer();
    logIndex = 0;
  });

  it('AddedWallet creates user and wallet and links them', async (t) => {
    await runEvents(indexer, addedWalletEvent(WALLET_A));

    const user = await indexer.User.getOrThrow(USER_ID);
    t.expect(user.chainId).toBe(CHAIN_ID);

    const wallet = await indexer.Wallet.getOrThrow(WALLET_ID);
    t.expect(wallet.address).toBe(WALLET_A);
    t.expect(wallet.user_id).toBe(USER_ID);
    t.expect(wallet.certifiedPartner_id).toBeUndefined();
  });

  it('repeated AddedWallet is idempotent and re-linking moves the wallet to the new user', async (t) => {
    await runEvents(
      indexer,
      addedWalletEvent(WALLET_A),
      addedWalletEvent(WALLET_A),
      addedWalletEvent(WALLET_A, OTHER_USER_STRING),
    );

    t.expect(await indexer.User.getAll()).toHaveLength(2);
    t.expect(await indexer.Wallet.getAll()).toHaveLength(1);

    const wallet = await indexer.Wallet.getOrThrow(WALLET_ID);
    t.expect(wallet.user_id).toBe(`${CHAIN_ID}-${OTHER_USER_STRING}`);
  });

  it('RemovedWallet unlinks the wallet but keeps the entities', async (t) => {
    await runEvents(
      indexer,
      addedWalletEvent(WALLET_A),
      removedWalletEvent(WALLET_A),
    );

    const wallet = await indexer.Wallet.getOrThrow(WALLET_ID);
    t.expect(wallet.user_id).toBeUndefined();
    t.expect(await indexer.User.getOrThrow(USER_ID)).toBeTruthy();
  });
});
