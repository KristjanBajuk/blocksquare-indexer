process.env.ENVIO_NETWORK = 'testnet';

import { describe, it, beforeEach } from 'vitest';
import { createTestIndexer, type TestIndexer, type TestIndexerProcessConfig } from 'envio';
import { CHAIN_ID, addr } from './fixtures';

type ChainSimulate = NonNullable<
  NonNullable<TestIndexerProcessConfig['chains'][typeof CHAIN_ID]>['simulate']
>;

// Static CertifiedPartners contract address from config.yaml (chain 11155111).
const CP_CONTRACT = addr('0x2192d72E0648277Ae50f2Ce516c5fD1B90572030');
const WALLET_A = addr('0x1111111111111111111111111111111111111111');
const CP_BYTES = `0x${'cb'.repeat(32)}`;
const CP_NAME = 'Partner One';
const USER_1 = 'aa'.repeat(32);
const USER_2 = 'bb'.repeat(32);

const CP_ID = `${CHAIN_ID}-${CP_BYTES}`;
const WALLET_ID = `${CHAIN_ID}-${WALLET_A}`;
const ucpId = (user: string) => `${CHAIN_ID}-${user}-${CP_BYTES}`;

let logIndex = 0;
const cpEvent = (
  event: string,
  params: Record<string, unknown>,
): ChainSimulate[number] => {
  logIndex += 1;
  return {
    contract: 'CertifiedPartners',
    event,
    srcAddress: CP_CONTRACT,
    logIndex,
    block: { number: 100 + logIndex, timestamp: 1_700_000_000 },
    transaction: { hash: `0x${'ef'.repeat(31)}${logIndex.toString(16).padStart(2, '0')}` },
    params,
  } as ChainSimulate[number];
};

const runEvents = (indexer: TestIndexer, ...events: ChainSimulate) =>
  indexer.process({ chains: { [CHAIN_ID]: { simulate: events } } });

describe('CertifiedPartners', () => {
  let indexer: TestIndexer;

  beforeEach(() => {
    indexer = createTestIndexer();
    logIndex = 0;
  });

  it('AddedCertifiedPartner creates the partner with its name', async (t) => {
    await runEvents(indexer, cpEvent('AddedCertifiedPartner', { cpBytes: CP_BYTES, cp: CP_NAME }));

    const partner = await indexer.CertifiedPartner.getOrThrow(CP_ID);
    t.expect(partner.name).toBe(CP_NAME);
    t.expect(partner.chainId).toBe(CHAIN_ID);
  });

  it('AddedWallet creates a wallet linked to the partner', async (t) => {
    await runEvents(
      indexer,
      cpEvent('AddedWallet', { cp: CP_BYTES, wallet: WALLET_A, cpName: CP_NAME }),
    );

    const wallet = await indexer.Wallet.getOrThrow(WALLET_ID);
    t.expect(wallet.address).toBe(WALLET_A);
    t.expect(wallet.certifiedPartner_id).toBe(CP_ID);
    t.expect(wallet.user_id).toBeUndefined();
  });

  it('RemovedWallet unlinks the wallet from the partner', async (t) => {
    await runEvents(
      indexer,
      cpEvent('AddedWallet', { cp: CP_BYTES, wallet: WALLET_A, cpName: CP_NAME }),
      cpEvent('RemovedWallet', { cp: CP_BYTES, wallet: WALLET_A }),
    );

    const wallet = await indexer.Wallet.getOrThrow(WALLET_ID);
    t.expect(wallet.certifiedPartner_id).toBeUndefined();
  });

  it('AddedWallet keeps an existing wallet and only updates the partner link', async (t) => {
    indexer.Wallet.set({
      id: WALLET_ID,
      address: WALLET_A,
      chainId: CHAIN_ID,
      user_id: `${CHAIN_ID}-${USER_1}`,
      certifiedPartner_id: undefined,
    });
    indexer.User.set({ id: `${CHAIN_ID}-${USER_1}`, chainId: CHAIN_ID });

    await runEvents(
      indexer,
      cpEvent('AddedWallet', { cp: CP_BYTES, wallet: WALLET_A, cpName: CP_NAME }),
    );

    const wallet = await indexer.Wallet.getOrThrow(WALLET_ID);
    t.expect(wallet.certifiedPartner_id).toBe(CP_ID);
    t.expect(wallet.user_id).toBe(`${CHAIN_ID}-${USER_1}`);
    t.expect(await indexer.Wallet.getAll()).toHaveLength(1);
  });

  it('AddedWhitelisted creates whitelist entries and RemovedWhitelisted deletes them', async (t) => {
    await runEvents(
      indexer,
      cpEvent('AddedWhitelisted', { cp: CP_BYTES, users: [USER_1, USER_2], cpName: CP_NAME }),
      cpEvent('RemovedWhitelisted', { cp: CP_BYTES, users: [USER_1], cpName: CP_NAME }),
    );

    const entry = await indexer.UserCertifiedPartner.getOrThrow(ucpId(USER_2));
    t.expect(entry.user_id).toBe(`${CHAIN_ID}-${USER_2}`);
    t.expect(entry.certifiedPartner_id).toBe(CP_ID);

    t.expect(await indexer.UserCertifiedPartner.get(ucpId(USER_1))).toBeUndefined();
    t.expect(await indexer.UserCertifiedPartner.getAll()).toHaveLength(1);
  });
});
