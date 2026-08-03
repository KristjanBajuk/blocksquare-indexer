process.env.ENVIO_NETWORK = 'testnet';

import { describe, it, beforeEach } from 'vitest';
import { createTestIndexer, type TestIndexer, type TestIndexerProcessConfig } from 'envio';
import { CHAIN_ID, addr, setPropertyToken } from './fixtures';
import { MOCK_PROPERTY_ADDRESS } from '../src/helper/PropertyToken';

type ChainSimulate = NonNullable<
  NonNullable<TestIndexerProcessConfig['chains'][typeof CHAIN_ID]>['simulate']
>;

const PROPERTY_TOKEN_ADDRESS = addr('0x1111111111111111111111111111111111111111');
const UNKNOWN_PROPERTY_ADDRESS = addr('0x9999999999999999999999999999999999999999');
const CERTIFIED_PARTNER_ID = `${CHAIN_ID}-cp1`;
const PROPERTY_TOKEN_ID = `${CHAIN_ID}-${PROPERTY_TOKEN_ADDRESS}`;
const BLOCK_TIMESTAMP = 1_700_000_000;

const eventBase = (logIndex: number) => ({
  contract: 'PropertyRegistry' as const,
  logIndex,
  block: { number: 100, timestamp: BLOCK_TIMESTAMP },
  transaction: { hash: `0x${'ab'.repeat(31)}${logIndex.toString(16).padStart(2, '0')}` },
});

const propertyValuationChangeEvent = (
  property: `0x${string}`,
  newValuationProperty: bigint,
  logIndex = 1,
): ChainSimulate[number] => ({
  ...eventBase(logIndex),
  event: 'PropertyValuationChange',
  params: { property, newValuationProperty },
});

const nameAndSymbolChangeEvent = (
  property: `0x${string}`,
  newName: string,
  newSymbol: string,
  logIndex = 1,
): ChainSimulate[number] => ({
  ...eventBase(logIndex),
  event: 'NameAndSymbolChange',
  params: { property, newName, newSymbol },
});

const tokenValuationChangeEvent = (
  property: `0x${string}`,
  newTokenValuation: bigint,
  logIndex = 1,
): ChainSimulate[number] => ({
  ...eventBase(logIndex),
  event: 'TokenValuationChange',
  params: { property, newTokenValuation },
});

const runEvents = (indexer: TestIndexer, ...events: ChainSimulate) =>
  indexer.process({ chains: { [CHAIN_ID]: { simulate: events } } });

describe('PropertyRegistry', () => {
  let indexer: TestIndexer;

  beforeEach(() => {
    indexer = createTestIndexer();
    setPropertyToken(indexer, PROPERTY_TOKEN_ADDRESS, CERTIFIED_PARTNER_ID);
  });

  it('PropertyValuationChange updates the token and global aggregates', async (t) => {
    await runEvents(
      indexer,
      propertyValuationChangeEvent(PROPERTY_TOKEN_ADDRESS, 2_000_000n),
    );

    const token = await indexer.PropertyToken.getOrThrow(PROPERTY_TOKEN_ID);
    t.expect(token.propertyValuation).toBe(2_000_000n);
    t.expect(token.propertyValuationUpdateTimestamp).toBe(BLOCK_TIMESTAMP);

    const global = await indexer.Global.getOrThrow('0');
    t.expect(global.activePropertiesCount).toBe(1);
    t.expect(global.activePropertiesTotalValuation).toBe(2_000_000n);
    t.expect(global.activePropertiesCountryCount).toBe(1);

    t.expect(await indexer.PropertyTokenRecord.getAll()).toHaveLength(1);
    t.expect(await indexer.GlobalRecord.getAll()).toHaveLength(1);
  });

  it('PropertyValuationChange skips the mock property token', async (t) => {
    // No PropertyToken exists for the mock address; without the guard this would throw.
    await runEvents(
      indexer,
      propertyValuationChangeEvent(addr(MOCK_PROPERTY_ADDRESS), 2_000_000n),
    );

    t.expect(await indexer.Global.get('0')).toBeUndefined();
    t.expect(await indexer.PropertyTokenRecord.getAll()).toHaveLength(0);
  });

  it('NameAndSymbolChange updates the token and ignores unknown properties', async (t) => {
    await runEvents(
      indexer,
      nameAndSymbolChangeEvent(PROPERTY_TOKEN_ADDRESS, 'Renamed Property', 'RNP', 1),
      nameAndSymbolChangeEvent(UNKNOWN_PROPERTY_ADDRESS, 'Ghost', 'GST', 2),
    );

    const token = await indexer.PropertyToken.getOrThrow(PROPERTY_TOKEN_ID);
    t.expect(token.name).toBe('Renamed Property');
    t.expect(token.symbol).toBe('RNP');

    // The unknown property must not have been created.
    t.expect(await indexer.PropertyToken.getAll()).toHaveLength(1);
  });

  it('TokenValuationChange updates tokenValuation and writes a record', async (t) => {
    await runEvents(
      indexer,
      tokenValuationChangeEvent(PROPERTY_TOKEN_ADDRESS, 3_000_000n),
    );

    const token = await indexer.PropertyToken.getOrThrow(PROPERTY_TOKEN_ID);
    t.expect(token.tokenValuation).toBe(3_000_000n);
    t.expect(await indexer.PropertyTokenRecord.getAll()).toHaveLength(1);
  });
});
