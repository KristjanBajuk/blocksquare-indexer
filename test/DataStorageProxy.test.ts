process.env.ENVIO_NETWORK = 'testnet';

import { describe, it, beforeEach } from 'vitest';
import { createTestIndexer, type TestIndexer, type TestIndexerProcessConfig } from 'envio';
import { CHAIN_ID, addr, setPropertyToken } from './fixtures';
import { MOCK_PROPERTY_ADDRESS } from '../src/helper/PropertyToken';

type ChainSimulate = NonNullable<
  NonNullable<TestIndexerProcessConfig['chains'][typeof CHAIN_ID]>['simulate']
>;

const PROPERTY_TOKEN_ADDRESS = addr('0x1111111111111111111111111111111111111111');
const NEW_CP_WALLET_ADDRESS = addr('0x8888888888888888888888888888888888888888');
const OLD_CERTIFIED_PARTNER_ID = `${CHAIN_ID}-cp1`;
const NEW_CERTIFIED_PARTNER_ID = `${CHAIN_ID}-cp2`;

const PROPERTY_TOKEN_ID = `${CHAIN_ID}-${PROPERTY_TOKEN_ADDRESS}`;
const NEW_CP_WALLET_ID = `${CHAIN_ID}-${NEW_CP_WALLET_ADDRESS}`;

const transferPropertyToCPEvent = (
  property: `0x${string}`,
  cp: `0x${string}`,
): ChainSimulate[number] => ({
  contract: 'DataStorageProxy',
  event: 'TransferPropertyToCP',
  logIndex: 1,
  block: { number: 100, timestamp: 1_700_000_000 },
  transaction: { hash: `0x${'ab'.repeat(32)}` },
  params: { property, cp },
});

const runEvents = (indexer: TestIndexer, ...events: ChainSimulate) =>
  indexer.process({ chains: { [CHAIN_ID]: { simulate: events } } });

describe('DataStorageProxy TransferPropertyToCP', () => {
  let indexer: TestIndexer;

  beforeEach(() => {
    indexer = createTestIndexer();
    setPropertyToken(indexer, PROPERTY_TOKEN_ADDRESS, OLD_CERTIFIED_PARTNER_ID);
    indexer.Wallet.set({
      id: NEW_CP_WALLET_ID,
      address: NEW_CP_WALLET_ADDRESS,
      chainId: CHAIN_ID,
      user_id: undefined,
      certifiedPartner_id: NEW_CERTIFIED_PARTNER_ID,
    });
  });

  it('reassigns the property token to the new certified partner', async (t) => {
    await runEvents(
      indexer,
      transferPropertyToCPEvent(PROPERTY_TOKEN_ADDRESS, NEW_CP_WALLET_ADDRESS),
    );

    const token = await indexer.PropertyToken.getOrThrow(PROPERTY_TOKEN_ID);
    t.expect(token.certifiedPartner_id).toBe(NEW_CERTIFIED_PARTNER_ID);
    t.expect(token.certifiedPartnerWallet_id).toBe(NEW_CP_WALLET_ID);
  });

  it('skips the mock property token', async (t) => {
    // No PropertyToken/Wallet lookups should happen for the mock address.
    await runEvents(
      indexer,
      transferPropertyToCPEvent(addr(MOCK_PROPERTY_ADDRESS), NEW_CP_WALLET_ADDRESS),
    );

    const token = await indexer.PropertyToken.getOrThrow(PROPERTY_TOKEN_ID);
    t.expect(token.certifiedPartner_id).toBe(OLD_CERTIFIED_PARTNER_ID);
  });

  it('throws when the target wallet has no certified partner', async (t) => {
    indexer.Wallet.set({
      id: NEW_CP_WALLET_ID,
      address: NEW_CP_WALLET_ADDRESS,
      chainId: CHAIN_ID,
      user_id: undefined,
      certifiedPartner_id: undefined,
    });

    await t
      .expect(
        runEvents(indexer, transferPropertyToCPEvent(PROPERTY_TOKEN_ADDRESS, NEW_CP_WALLET_ADDRESS)),
      )
      .rejects.toThrow();
  });
});
