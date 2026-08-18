process.env.ENVIO_NETWORK = 'testnet';

import { describe, it, beforeEach } from 'vitest';
import { createTestIndexer, type TestIndexer, type TestIndexerProcessConfig } from 'envio';
import { CHAIN_ID, addr, setPropertyToken } from './fixtures';

type ChainSimulate = NonNullable<
  NonNullable<TestIndexerProcessConfig['chains'][typeof CHAIN_ID]>['simulate']
>;

const PROPERTY_TOKEN_ADDRESS = addr('0x1111111111111111111111111111111111111111');
const USDC_ADDRESS = addr('0x2222222222222222222222222222222222222222');
const OTHER_TOKEN_ADDRESS = addr('0x9999999999999999999999999999999999999999');
const MAKER_ADDRESS = addr('0x3333333333333333333333333333333333333333');
const TAKER_ADDRESS = addr('0x4444444444444444444444444444444444444444');
const FEE_RECIPIENT_ADDRESS = addr('0x5555555555555555555555555555555555555555');
const CERTIFIED_PARTNER_ID = `${CHAIN_ID}-cp1`;

const PROPERTY_TOKEN_ID = `${CHAIN_ID}-${PROPERTY_TOKEN_ADDRESS}`;
const MAKER_COUNTS_ID = `${CHAIN_ID}-${MAKER_ADDRESS}`;
const TAKER_COUNTS_ID = `${CHAIN_ID}-${TAKER_ADDRESS}`;

const limitOrderFilledEvent = (
  makerToken: `0x${string}`,
  takerToken: `0x${string}`,
  overrides: { logIndex?: number; blockNumber?: number } = {},
): ChainSimulate[number] => ({
  contract: 'ZeroEx',
  event: 'LimitOrderFilled',
  logIndex: overrides.logIndex ?? 1,
  block: { number: overrides.blockNumber ?? 100, timestamp: 1_700_000_000 },
  transaction: { hash: `0x${'cd'.repeat(31)}${(overrides.logIndex ?? 1).toString(16).padStart(2, '0')}` },
  params: {
    orderHash: `0x${'ab'.repeat(32)}`,
    maker: MAKER_ADDRESS,
    taker: TAKER_ADDRESS,
    feeRecipient: FEE_RECIPIENT_ADDRESS,
    makerToken,
    takerToken,
    takerTokenFilledAmount: 500n,
    makerTokenFilledAmount: 1_000n,
    takerTokenFeeFilledAmount: 0n,
    protocolFeePaid: 0n,
    pool: `0x${'00'.repeat(32)}`,
  },
});

const runEvents = (indexer: TestIndexer, ...events: ChainSimulate) =>
  indexer.process({ chains: { [CHAIN_ID]: { simulate: events } } });

describe('ZeroEx LimitOrderFilled', () => {
  let indexer: TestIndexer;

  beforeEach(() => {
    indexer = createTestIndexer();
    setPropertyToken(indexer, PROPERTY_TOKEN_ADDRESS, CERTIFIED_PARTNER_ID);
  });

  it('indexes a maker-side property token trade and updates totals', async (t) => {
    await runEvents(indexer, limitOrderFilledEvent(PROPERTY_TOKEN_ADDRESS, USDC_ADDRESS));

    const trades = await indexer.PropertyTokenTrade.getAll();
    t.expect(trades).toHaveLength(1);
    const trade = trades[0]!;
    t.expect(trade.protocol).toBe('ZeroEx');
    t.expect(trade.referralCode).toBe('');
    t.expect(trade.propertyToken_id).toBe(PROPERTY_TOKEN_ID);
    t.expect(trade.maker_id).toBe(`${CHAIN_ID}-${MAKER_ADDRESS}`);
    t.expect(trade.taker_id).toBe(`${CHAIN_ID}-${TAKER_ADDRESS}`);
    t.expect(trade.makerTokenFilledAmount).toBe(1_000n);
    t.expect(trade.takerTokenFilledAmount).toBe(500n);
    t.expect(trade.propertyValuation).toBe(1_000_000n);

    const token = await indexer.PropertyToken.getOrThrow(PROPERTY_TOKEN_ID);
    t.expect(token.totalPropertyTokenTraded).toBe(1_000n);
    t.expect(token.totalValueTraded).toBe(500n);
  });

  it('indexes a taker-side property token trade with swapped totals', async (t) => {
    await runEvents(indexer, limitOrderFilledEvent(USDC_ADDRESS, PROPERTY_TOKEN_ADDRESS));

    const token = await indexer.PropertyToken.getOrThrow(PROPERTY_TOKEN_ID);
    t.expect(token.totalPropertyTokenTraded).toBe(500n);
    t.expect(token.totalValueTraded).toBe(1_000n);
    t.expect(await indexer.PropertyTokenTrade.getAll()).toHaveLength(1);
  });

  it('updates maker/taker trade counts across multiple fills', async (t) => {
    await runEvents(
      indexer,
      limitOrderFilledEvent(PROPERTY_TOKEN_ADDRESS, USDC_ADDRESS, { logIndex: 1 }),
      limitOrderFilledEvent(PROPERTY_TOKEN_ADDRESS, USDC_ADDRESS, { logIndex: 2 }),
    );

    const makerCounts = await indexer.PropertyTokenTradeCounts.getOrThrow(MAKER_COUNTS_ID);
    t.expect(makerCounts.makerCount).toBe(2);
    t.expect(makerCounts.takerCount).toBe(0);

    const takerCounts = await indexer.PropertyTokenTradeCounts.getOrThrow(TAKER_COUNTS_ID);
    t.expect(takerCounts.takerCount).toBe(2);
    t.expect(takerCounts.makerCount).toBe(0);
  });

  it('ignores fills where neither side is a property token', async (t) => {
    await runEvents(indexer, limitOrderFilledEvent(OTHER_TOKEN_ADDRESS, USDC_ADDRESS));

    t.expect(await indexer.PropertyTokenTrade.getAll()).toHaveLength(0);
    t.expect(await indexer.PropertyTokenTradeCounts.getAll()).toHaveLength(0);

    const token = await indexer.PropertyToken.getOrThrow(PROPERTY_TOKEN_ID);
    t.expect(token.totalPropertyTokenTraded).toBe(0n);
  });
});
