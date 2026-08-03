process.env.ENVIO_NETWORK = 'testnet';

import { describe, it, beforeEach } from 'vitest';
import { createTestIndexer, type TestIndexer, type TestIndexerProcessConfig } from 'envio';
import { CHAIN_ID, addr, setPropertyToken } from './fixtures';

type ChainSimulate = NonNullable<
  NonNullable<TestIndexerProcessConfig['chains'][typeof CHAIN_ID]>['simulate']
>;

const PROPERTY_TOKEN_ADDRESS = addr('0x1111111111111111111111111111111111111111');
const USDC_ADDRESS = addr('0x2222222222222222222222222222222222222222');
const MAKER_ADDRESS = addr('0x3333333333333333333333333333333333333333');
const TAKER_ADDRESS = addr('0x4444444444444444444444444444444444444444');
const CERTIFIED_PARTNER_ID = `${CHAIN_ID}-cp1`;
const REFERRER_USER_BYTES = 'aa'.repeat(32);
const REFERRER_USER_ID = `${CHAIN_ID}-${REFERRER_USER_BYTES}`;
const VALID_EXTRA_DATA = `0x${REFERRER_USER_BYTES}`;

const PROPERTY_TOKEN_ID = `${CHAIN_ID}-${PROPERTY_TOKEN_ADDRESS}`;
const TAKER_WALLET_ID = `${CHAIN_ID}-${TAKER_ADDRESS}`;
const REFERRAL_ID = `${CHAIN_ID}-${CERTIFIED_PARTNER_ID}-${TAKER_ADDRESS}`;

const orderFilledEvent = (
  extraData: string,
  overrides: { logIndex?: number; blockNumber?: number } = {},
): ChainSimulate[number] => ({
  contract: 'OneInchPostInteraction',
  event: 'PostInteractionOrderFilled',
  logIndex: overrides.logIndex ?? 1,
  block: { number: overrides.blockNumber ?? 100, timestamp: 1_700_000_000 },
  transaction: { hash: `0x${'cd'.repeat(31)}${(overrides.logIndex ?? 1).toString(16).padStart(2, '0')}` },
  params: {
    orderHash: `0x${'ab'.repeat(32)}`,
    taker: TAKER_ADDRESS,
    makingAmount: 1_000n,
    remainingMakingAmount: 0n,
    order: {
      salt: 0n,
      maker: BigInt(MAKER_ADDRESS),
      receiver: 0n,
      makerAsset: BigInt(PROPERTY_TOKEN_ADDRESS),
      takerAsset: BigInt(USDC_ADDRESS),
      makingAmount: 1_000n,
      takingAmount: 500n,
      makerTraits: 0n,
    },
    extension: '0x',
    takingAmount: 500n,
    extraData,
  },
});

const runEvents = (indexer: TestIndexer, ...events: ChainSimulate) =>
  indexer.process({ chains: { [CHAIN_ID]: { simulate: events } } });

describe('OneInch referral extraction', () => {
  let indexer: TestIndexer;

  beforeEach(() => {
    indexer = createTestIndexer();
    setPropertyToken(indexer, PROPERTY_TOKEN_ADDRESS, CERTIFIED_PARTNER_ID);
    indexer.User.set({ id: REFERRER_USER_ID, chainId: CHAIN_ID });
  });

  it('creates a referral and stores the code on the trade for a valid extraData', async (t) => {
    await runEvents(indexer, orderFilledEvent(VALID_EXTRA_DATA));

    const referral = await indexer.Referral.getOrThrow(REFERRAL_ID);
    t.expect(referral.referrer_id).toBe(REFERRER_USER_ID);
    t.expect(referral.wallet_id).toBe(TAKER_WALLET_ID);
    t.expect(referral.marketplace_id).toBe(CERTIFIED_PARTNER_ID);

    const trades = await indexer.PropertyTokenTrade.getAll();
    t.expect(trades).toHaveLength(1);
    t.expect(trades[0]?.referralCode).toBe(VALID_EXTRA_DATA);
    t.expect(referral.firstOrderTrade_id).toBe(trades[0]?.id);
  });

  it('ignores malformed extraData but still indexes the trade', async (t) => {
    await runEvents(indexer, orderFilledEvent('0x1234'));

    t.expect(await indexer.Referral.getAll()).toHaveLength(0);
    const trades = await indexer.PropertyTokenTrade.getAll();
    t.expect(trades).toHaveLength(1);
    t.expect(trades[0]?.referralCode).toBe('');
  });

  it('ignores referral codes pointing to a non-existing user', async (t) => {
    await runEvents(indexer, orderFilledEvent(`0x${'bb'.repeat(32)}`));

    t.expect(await indexer.Referral.getAll()).toHaveLength(0);
    t.expect((await indexer.PropertyTokenTrade.getAll())[0]?.referralCode).toBe('');
  });

  it('rejects self-referral', async (t) => {
    indexer.Wallet.set({
      id: TAKER_WALLET_ID,
      address: TAKER_ADDRESS,
      chainId: CHAIN_ID,
      user_id: REFERRER_USER_ID,
      certifiedPartner_id: undefined,
    });

    await runEvents(indexer, orderFilledEvent(VALID_EXTRA_DATA));

    t.expect(await indexer.Referral.getAll()).toHaveLength(0);
    t.expect((await indexer.PropertyTokenTrade.getAll())[0]?.referralCode).toBe('');
  });

  it('keeps the first-order trade on repeat orders', async (t) => {
    await runEvents(
      indexer,
      orderFilledEvent(VALID_EXTRA_DATA, { logIndex: 1, blockNumber: 100 }),
      orderFilledEvent(VALID_EXTRA_DATA, { logIndex: 2, blockNumber: 101 }),
    );

    const referrals = await indexer.Referral.getAll();
    t.expect(referrals).toHaveLength(1);

    const trades = await indexer.PropertyTokenTrade.getAll();
    t.expect(trades).toHaveLength(2);
    const firstTrade = trades.find((trade) => trade.blockNumber === 100);
    t.expect(referrals[0]?.firstOrderTrade_id).toBe(firstTrade?.id);
  });
});
