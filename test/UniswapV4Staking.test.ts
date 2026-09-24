process.env.ENVIO_NETWORK = 'testnet';

import { describe, it, beforeEach } from 'vitest';
import { createTestIndexer, type TestIndexer, type TestIndexerProcessConfig } from 'envio';
import { AbiCoder, concat, keccak256, ZeroAddress } from 'ethers';
import { CHAIN_ID, addr } from './fixtures';
import {
  buildMerkleTree,
  compareBigInt,
  getPredictedDailyBlockCount,
  getUniswapV4StakingDeployementBlock,
  TOTAL_DAILY_REWARDS,
} from '../src/helper/UniswapV4Helpers/utils';

type ChainSimulate = NonNullable<
  NonNullable<TestIndexerProcessConfig['chains'][typeof CHAIN_ID]>['simulate']
>;

const ZERO = ZeroAddress as `0x${string}`;
// Static testnet addresses from src/config/testnet.ts / config.yaml.
const STAKING_ADDRESS = addr('0xfdf22B183490f005e2e51A6Caf4202E46cc11b97');
const POSITION_MANAGER_ADDRESS = addr('0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4');
const BST_ADDRESS = addr('0x7000Ec7486d8c6f9bd9FfA930f9ACE2D9564d02b');
const ALICE = addr('0x6666666666666666666666666666666666666666');

const STAKING_POOL_ENTITY_ID = `${CHAIN_ID}-${STAKING_ADDRESS}`;

const TOKEN_ID = 7n;
const TOKEN_ENTITY_ID = `${CHAIN_ID}-${TOKEN_ID}`;
const MINT_TX = `0x${'aa'.repeat(32)}`;
const UNI_POSITION_ID = `${CHAIN_ID}-${MINT_TX}`;
const STAKING_POSITION_ID = `${CHAIN_ID}-${ALICE}-${TOKEN_ID}`;

// Simulate delivers the indexed PoolKey tuple as a positional array;
// the handler derives the pool entity id as keccak256(abi.encode(PoolKey)) — the V4 poolId.
const TARGET_POOL_KEY = [ZERO, BST_ADDRESS, 3000n, 60n, ZERO] as const;
const POOL_ID = keccak256(
  AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [...TARGET_POOL_KEY],
  ),
);
const UNI_POOL_ENTITY_ID = `${CHAIN_ID}-${POOL_ID}`;

const lpStakingInitEvent = (
  overrides: { minDays?: bigint; logIndex?: number; blockNumber?: number } = {},
): ChainSimulate[number] =>
  ({
    contract: 'UniswapV4Staking',
    event: 'LPStakingInit',
    logIndex: overrides.logIndex ?? 1,
    block: { number: overrides.blockNumber ?? 100, timestamp: 1_700_000_000 },
    transaction: { hash: `0x${'bb'.repeat(32)}` },
    params: {
      positionManager: POSITION_MANAGER_ADDRESS,
      targetPoolKey: TARGET_POOL_KEY,
      minDays: overrides.minDays ?? 7n,
      maxDays: 365n,
      minBoost: 100n,
      maxBoost: 200n,
      earlyPositionSlash: 10n,
      earlyRewardSlash: 50n,
    },
  }) as unknown as ChainSimulate[number];

const depositEvent = (
  overrides: {
    tokenId?: bigint;
    liquidity?: bigint;
    lockedUntil?: bigint;
    timeBoost?: bigint;
    logIndex?: number;
    blockNumber?: number;
  } = {},
): ChainSimulate[number] => ({
  contract: 'UniswapV4Staking',
  event: 'Deposit',
  logIndex: overrides.logIndex ?? 1,
  block: { number: overrides.blockNumber ?? 100, timestamp: 1_700_000_000 },
  transaction: { hash: `0x${'cc'.repeat(32)}` },
  params: {
    owner: ALICE,
    tokenId: overrides.tokenId ?? TOKEN_ID,
    liquidity: overrides.liquidity ?? 10n ** 18n,
    lockedUntil: overrides.lockedUntil ?? 1_710_000_000n,
    timeBoost: overrides.timeBoost ?? 122n,
  },
});

const withdrawEvent = (
  overrides: { logIndex?: number; blockNumber?: number } = {},
): ChainSimulate[number] => ({
  contract: 'UniswapV4Staking',
  event: 'Withdraw',
  logIndex: overrides.logIndex ?? 2,
  block: { number: overrides.blockNumber ?? 101, timestamp: 1_700_000_100 },
  transaction: { hash: `0x${'dd'.repeat(32)}` },
  params: { owner: ALICE, tokenId: TOKEN_ID, liquidity: 10n ** 18n },
});

const runEvents = (indexer: TestIndexer, ...events: ChainSimulate) =>
  indexer.process({ chains: { [CHAIN_ID]: { simulate: events } } });

const setPositionToken = (indexer: TestIndexer) =>
  indexer.UniswapV4PositionToken.set({
    id: TOKEN_ENTITY_ID,
    tokenId: TOKEN_ID,
    owner: ALICE,
    isBurned: false,
    mintedTransactionHash: MINT_TX,
    wallet_id: `${CHAIN_ID}-${ALICE}`,
    position_id: UNI_POSITION_ID,
  });

describe('UniswapV4Staking', () => {
  let indexer: TestIndexer;

  beforeEach(() => {
    indexer = createTestIndexer();
    setPositionToken(indexer);
  });

  it('LPStakingInit creates the staking pool once when the target Uniswap pool exists', async (t) => {
    indexer.UniswapV4Pool.set({
      id: UNI_POOL_ENTITY_ID,
      chainId: CHAIN_ID,
      poolId: POOL_ID,
      currency0: ZERO,
      currency1: BST_ADDRESS,
      fee: 3000n,
      tickSpacing: 60n,
      hooks: ZERO,
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: 0n,
      createdAtTimestamp: 1_699_999_000,
      creationTransaction: `0x${'ee'.repeat(32)}`,
    });

    await runEvents(
      indexer,
      lpStakingInitEvent({ blockNumber: 100, logIndex: 1 }),
      // Second init must not overwrite the existing staking pool config.
      lpStakingInitEvent({ minDays: 30n, blockNumber: 101, logIndex: 2 }),
    );

    const pools = await indexer.StakingPoolV4.getAll();
    t.expect(pools).toHaveLength(1);

    const pool = await indexer.StakingPoolV4.getOrThrow(STAKING_POOL_ENTITY_ID);
    t.expect(pool.contractAddress).toBe(STAKING_ADDRESS);
    t.expect(pool.positionManager).toBe(POSITION_MANAGER_ADDRESS);
    t.expect(pool.targetPoolKey).toBe(POOL_ID);
    t.expect(pool.minDays).toBe(7n);
    t.expect(pool.maxDays).toBe(365n);
    t.expect(pool.minBoost).toBe(100n);
    t.expect(pool.maxBoost).toBe(200n);
    t.expect(pool.earlyPositionSlash).toBe(10n);
    t.expect(pool.earlyRewardSlash).toBe(50n);
    t.expect(pool.totalRewardsAdded).toBe(0n);
    t.expect(pool.uniswapV4Pool_id).toBe(UNI_POOL_ENTITY_ID);
  });

  it('LPStakingInit is ignored when the target Uniswap pool is not indexed', async (t) => {
    await runEvents(indexer, lpStakingInitEvent());

    t.expect(await indexer.StakingPoolV4.getAll()).toHaveLength(0);
  });

  it('Deposit creates a staking position linked to the NFT and writes a DEPOSIT record', async (t) => {
    await runEvents(indexer, depositEvent());

    const position = await indexer.StakingPoolV4Position.getOrThrow(STAKING_POSITION_ID);
    t.expect(position.tokenId).toBe(TOKEN_ID);
    t.expect(position.liquidity).toBe(10n ** 18n);
    t.expect(position.lockedUntil).toBe(1_710_000_000n);
    t.expect(position.timeBoost).toBe(122n);
    t.expect(position.isPositionClosed).toBe(false);
    t.expect(position.wallet_id).toBe(`${CHAIN_ID}-${ALICE}`);
    t.expect(position.pool_id).toBe(STAKING_POOL_ENTITY_ID);
    t.expect(position.positionToken_id).toBe(TOKEN_ENTITY_ID);
    t.expect(position.uniPosition_id).toBe(UNI_POSITION_ID);

    const records = await indexer.StakingPoolV4PositionRecord.getAll();
    t.expect(records).toHaveLength(1);
    t.expect(records[0]?.transactionType).toBe('DEPOSIT');
    t.expect(records[0]?.tokenId).toBe(TOKEN_ID);
    t.expect(records[0]?.stakingPosition_id).toBe(STAKING_POSITION_ID);
    t.expect(records[0]?.wallet_id).toBe(`${CHAIN_ID}-${ALICE}`);
  });

  it('Deposit is ignored when the NFT position token is unknown', async (t) => {
    await runEvents(indexer, depositEvent({ tokenId: 999n }));

    t.expect(await indexer.StakingPoolV4Position.getAll()).toHaveLength(0);
    t.expect(await indexer.StakingPoolV4PositionRecord.getAll()).toHaveLength(0);
  });

  it('Withdraw closes the staking position and writes a WITHDRAW record', async (t) => {
    await runEvents(
      indexer,
      depositEvent({ blockNumber: 100, logIndex: 1 }),
      withdrawEvent({ blockNumber: 101, logIndex: 2 }),
    );

    const position = await indexer.StakingPoolV4Position.getOrThrow(STAKING_POSITION_ID);
    t.expect(position.isPositionClosed).toBe(true);
    t.expect(position.updatedAtTimestamp).toBe(1_700_000_100);

    const records = await indexer.StakingPoolV4PositionRecord.getAll();
    t.expect(records).toHaveLength(2);
    t.expect(records.map((r) => r.transactionType).sort()).toEqual(['DEPOSIT', 'WITHDRAW']);
    const withdrawRecord = records.find((r) => r.transactionType === 'WITHDRAW');
    t.expect(withdrawRecord?.stakingPosition_id).toBe(STAKING_POSITION_ID);
    t.expect(withdrawRecord?.wallet_id).toBe(`${CHAIN_ID}-${ALICE}`);
    t.expect(withdrawRecord?.pool_id).toBe(STAKING_POOL_ENTITY_ID);
  });

  it('re-depositing the same NFT after withdraw reopens the position with updated terms', async (t) => {
    await runEvents(
      indexer,
      depositEvent({ blockNumber: 100, logIndex: 1 }),
      withdrawEvent({ blockNumber: 101, logIndex: 2 }),
      depositEvent({
        liquidity: 2n * 10n ** 18n,
        lockedUntil: 1_720_000_000n,
        timeBoost: 150n,
        blockNumber: 102,
        logIndex: 3,
      }),
    );

    const position = await indexer.StakingPoolV4Position.getOrThrow(STAKING_POSITION_ID);
    t.expect(position.isPositionClosed).toBe(false);
    t.expect(position.liquidity).toBe(2n * 10n ** 18n);
    t.expect(position.lockedUntil).toBe(1_720_000_000n);
    t.expect(position.timeBoost).toBe(150n);
    t.expect(await indexer.StakingPoolV4Position.getAll()).toHaveLength(1);
    t.expect(await indexer.StakingPoolV4PositionRecord.getAll()).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Daily reward trees. The contract only verifies proofs against its single latest
// root and tracks claims per tokenId, so every NFT that has ever earned must be in
// every tree, keyed by tokenId.
//
// Each test runs one `process()` call: the test indexer can't resume a chain whose
// config has contracts starting before the resumed block (e.g. ZeroEx). Trees are
// read back per block from the returned changes.
// ---------------------------------------------------------------------------

const DEPLOY_BLOCK = getUniswapV4StakingDeployementBlock(CHAIN_ID);
const DAY_BLOCKS = getPredictedDailyBlockCount(CHAIN_ID);
const dayBlock = (day: number) => DEPLOY_BLOCK + (day - 1) * DAY_BLOCKS;

const BOB = addr('0x7777777777777777777777777777777777777777');
const CAROL = addr('0x8888888888888888888888888888888888888888');
const DAVE = addr('0x9999999999999999999999999999999999999999');
// Smart-wallet case: claims arrive through a relayer, not from the NFT holder.
const RELAYER = addr('0x5555555555555555555555555555555555555555');

// #43 has a narrow range and leaves it when the pool tick moves to 120; the others stay in range.
const WIDE_RANGE = { tickLower: -600n, tickUpper: 600n };
const NARROW_RANGE = { tickLower: -60n, tickUpper: 60n };
const OUT_OF_NARROW_RANGE_TICK = 120n;

const THIRD = TOTAL_DAILY_REWARDS / 3n;
const HALF = TOTAL_DAILY_REWARDS / 2n;
const FULL = TOTAL_DAILY_REWARDS;

const rewardId = (tokenId: bigint) => `${CHAIN_ID}-${tokenId}`;
const wallet = (address: string) => `${CHAIN_ID}-${address}`;

// Root the operator would publish for these totals.
const rootOf = (totals: Record<string, bigint>) =>
  buildMerkleTree(
    Object.entries(totals)
      .map(([tokenId, cumulativeReward]) => ({ tokenId: BigInt(tokenId), cumulativeReward }))
      .sort((a, b) => compareBigInt(a.tokenId, b.tokenId)),
  ).root;

// Mirrors the contract: leaf = keccak256(abi.encode(tokenId, cumulative)), solady MerkleProofLib (sorted pairs).
const verifyProof = (proof: readonly string[], root: string, tokenId: bigint, cumulative: bigint) => {
  let node = keccak256(AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [tokenId, cumulative]));
  for (const sibling of proof) {
    node = BigInt(node) < BigInt(sibling) ? keccak256(concat([node, sibling])) : keccak256(concat([sibling, node]));
  }
  return node === root;
};

const txAt = (blockNumber: number, from: `0x${string}`) => ({
  block: { number: blockNumber, timestamp: 1_700_000_000 + blockNumber },
  transaction: { hash: `0x${blockNumber.toString(16).padStart(64, '0')}`, from },
});

const stakingEvent = (
  event: 'Deposit' | 'Withdraw' | 'EarlyWithdraw' | 'Reward' | 'RewardsClaimed' | 'RewardsBurned',
  blockNumber: number,
  params: Record<string, unknown>,
  from: `0x${string}` = RELAYER,
) => ({ contract: 'UniswapV4Staking', event, ...txAt(blockNumber, from), params }) as unknown as ChainSimulate[number];

const deposit = (blockNumber: number, owner: `0x${string}`, tokenId: bigint) =>
  stakingEvent('Deposit', blockNumber, { owner, tokenId, liquidity: 10n ** 18n, lockedUntil: 1_800_000_000n, timeBoost: 100n }, owner);
const publishRoot = (blockNumber: number, merkleRoot: string) =>
  stakingEvent('Reward', blockNumber, { from: RELAYER, amount: FULL, merkleRoot });
const claim = (blockNumber: number, tokenId: bigint, amount: bigint) =>
  stakingEvent('RewardsClaimed', blockNumber, { tokenId, amount });
const swapToTick = (blockNumber: number, tick: bigint) =>
  ({
    contract: 'UniswapV4PoolManager',
    event: 'Swap',
    ...txAt(blockNumber, RELAYER),
    params: { id: POOL_ID, sender: RELAYER, amount0: 1n, amount1: -1n, sqrtPriceX96: 79228162514264337593543950336n, liquidity: 10n ** 18n, tick, fee: 3000n },
  }) as unknown as ChainSimulate[number];
const nftTransfer = (blockNumber: number, from: `0x${string}`, to: `0x${string}`, id: bigint) =>
  ({ contract: 'UniswapV4PositionManager', event: 'Transfer', ...txAt(blockNumber, from), params: { from, to, id } }) as unknown as ChainSimulate[number];

type Changes = Awaited<ReturnType<TestIndexer['process']>>['changes'];
const rewardSetsAt = (changes: Changes, block: number) =>
  changes.find((c) => c.block === block)?.UserCumulativeReward?.sets ?? [];

describe('UniswapV4Staking daily reward trees', () => {
  let indexer: TestIndexer;

  const setNft = (tokenId: bigint, owner: `0x${string}`, range: { tickLower: bigint; tickUpper: bigint }) => {
    indexer.UniswapV4PositionToken.set({
      id: rewardId(tokenId),
      tokenId,
      owner,
      isBurned: false,
      mintedTransactionHash: '',
      wallet_id: wallet(owner),
      position_id: `uni-${tokenId}`,
    });
    indexer.UniswapV4PoolPosition.set({
      id: `uni-${tokenId}`,
      uniqueKey: `uni-${tokenId}`,
      chainId: CHAIN_ID,
      ...range,
      liquidityDelta: 10n ** 18n,
      salt: '',
      amount0: 0n,
      amount1: 0n,
      transactionHash: '',
      pool_id: UNI_POOL_ENTITY_ID,
    });
  };

  const run = async (endBlock: number, ...events: ChainSimulate) =>
    (await indexer.process({ chains: { [CHAIN_ID]: { endBlock, simulate: events } } })).changes;

  const rewards = async () =>
    new Map((await indexer.UserCumulativeReward.getAll()).map((r) => [r.tokenId, r]));

  // A daily run's tree: one leaf per NFT with a nonzero total, every proof valid against the root.
  const expectTree = (
    t: { expect: typeof import('vitest').expect },
    changes: Changes,
    day: number,
    expected: Record<string, bigint>,
  ) => {
    const root = rootOf(expected);
    const sets = rewardSetsAt(changes, dayBlock(day));
    t.expect(Object.fromEntries(sets.map((r) => [r.tokenId.toString(), r.cumulativeReward]))).toEqual(expected);
    t.expect(new Set(sets.map((r) => r.tokenId)).size).toBe(sets.length);
    for (const r of sets) {
      t.expect(r.id).toBe(rewardId(r.tokenId));
      t.expect(r.merkleRoot).toBe(root);
      t.expect(r.updatedAtTimestamp).toBe(0);
      t.expect(verifyProof(r.proof, root, r.tokenId, r.cumulativeReward)).toBe(true);
    }
  };

  beforeEach(() => {
    indexer = createTestIndexer();
    indexer.UniswapV4Pool.set({
      id: UNI_POOL_ENTITY_ID,
      chainId: CHAIN_ID,
      poolId: POOL_ID,
      currency0: ZERO,
      currency1: BST_ADDRESS,
      fee: 3000n,
      tickSpacing: 60n,
      hooks: ZERO,
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: 0n,
      createdAtTimestamp: 1_699_999_000,
      creationTransaction: `0x${'ee'.repeat(32)}`,
    });
    indexer.StakingPoolV4.set({
      id: STAKING_POOL_ENTITY_ID,
      chainId: CHAIN_ID,
      contractAddress: STAKING_ADDRESS,
      positionManager: POSITION_MANAGER_ADDRESS,
      targetPoolKey: POOL_ID,
      minDays: 7n,
      maxDays: 365n,
      minBoost: 100n,
      maxBoost: 200n,
      earlyPositionSlash: 10n,
      earlyRewardSlash: 50n,
      totalRewardsAdded: 0n,
      totalRewardsClaimed: 0n,
      totalRewardsBurned: 0n,
      createdAtTimestamp: 1_699_999_000,
      creationTransaction: `0x${'bb'.repeat(32)}`,
      uniswapV4Pool_id: UNI_POOL_ENTITY_ID,
    });
    setNft(42n, ALICE, WIDE_RANGE);
    setNft(43n, BOB, NARROW_RANGE);
    setNft(44n, CAROL, WIDE_RANGE);
  });

  it('keeps every NFT claimable across out-of-range days, withdrawals and resales', async (t) => {
    const day1 = { '42': THIRD, '43': THIRD, '44': THIRD };
    const day2 = { '42': THIRD + HALF, '43': THIRD, '44': THIRD + HALF };
    const day3 = { '42': THIRD + HALF, '43': THIRD + FULL, '44': THIRD + HALF };
    const day4 = { '42': THIRD + HALF, '43': THIRD + FULL + HALF, '44': THIRD + HALF + HALF };
    const [r1, r2, r3, r4] = [day1, day2, day3, day4].map(rootOf);

    const changes = await run(
      dayBlock(4) + 10,
      // Step 1: all three staked and in range for day 1.
      deposit(dayBlock(1) - 30, ALICE, 42n),
      deposit(dayBlock(1) - 20, BOB, 43n),
      deposit(dayBlock(1) - 10, CAROL, 44n),
      // Step 2: publish R1; Carol claims #44 through a relayer.
      publishRoot(dayBlock(1) + 10, r1!),
      claim(dayBlock(1) + 11, 44n, THIRD),
      // Step 3: #43 goes out of range before day 2.
      swapToTick(dayBlock(1) + 20, OUT_OF_NARROW_RANGE_TICK),
      // Step 4: publish R2; Bob claims his carried-forward #43.
      publishRoot(dayBlock(2) + 10, r2!),
      claim(dayBlock(2) + 11, 43n, THIRD),
      // Step 5: Alice early-withdraws #42 unclaimed; Carol withdraws #44 and sells it to Dave; #43 back in range.
      stakingEvent('EarlyWithdraw', dayBlock(2) + 20, { owner: ALICE, tokenId: 42n, liquidity: 10n ** 18n, positionSlash: 0n }, ALICE),
      stakingEvent('Withdraw', dayBlock(2) + 21, { owner: CAROL, tokenId: 44n, liquidity: 10n ** 18n }, CAROL),
      nftTransfer(dayBlock(2) + 22, CAROL, DAVE, 44n),
      swapToTick(dayBlock(2) + 23, 0n),
      // Step 6: publish R3; Alice claims #42 after withdrawing.
      publishRoot(dayBlock(3) + 10, r3!),
      claim(dayBlock(3) + 11, 42n, THIRD + HALF),
      // Step 7: Dave stakes #44.
      deposit(dayBlock(3) + 20, DAVE, 44n),
      // Step 8: publish R4.
      publishRoot(dayBlock(4) + 10, r4!),
    );

    expectTree(t, changes, 1, day1);
    expectTree(t, changes, 2, day2); // #43 carried while out of range
    expectTree(t, changes, 3, day3); // withdrawn #42 and resold #44 carried
    expectTree(t, changes, 4, day4); // Dave continues the same #44 record

    // Step 4: Bob's carried-forward leaf was distributed under R2 with a valid proof.
    const bobAtR2 = rewardSetsAt(changes, dayBlock(2) + 10).find((r) => r.tokenId === 43n)!;
    t.expect(bobAtR2.isRewardsDistributed).toBe(true);
    t.expect(bobAtR2.lastDistributedMerkleRoot).toBe(r2);
    t.expect(verifyProof(bobAtR2.lastDistributedProof, r2!, 43n, THIRD)).toBe(true);

    // Step 6: Alice's withdrawn #42 was distributed under R3 with its full total.
    const aliceAtR3 = rewardSetsAt(changes, dayBlock(3) + 10).find((r) => r.tokenId === 42n)!;
    t.expect(aliceAtR3.lastDistributedCumulativeReward).toBe(THIRD + HALF);
    t.expect(verifyProof(aliceAtR3.lastDistributedProof, r3!, 42n, THIRD + HALF)).toBe(true);

    // Claims land on the tokenId record and name the staker or holder, not the relayer.
    const claims = (await indexer.StakingPoolV4PositionRecord.getAll()).filter((r) => r.transactionType === 'REWARDS_CLAIMED');
    t.expect(Object.fromEntries(claims.map((r) => [r.tokenId.toString(), [r.wallet_id, r.stakingPosition_id]]))).toEqual({
      '42': [wallet(ALICE), `${CHAIN_ID}-${ALICE}-42`],
      '43': [wallet(BOB), `${CHAIN_ID}-${BOB}-43`],
      '44': [wallet(CAROL), `${CHAIN_ID}-${CAROL}-44`],
    });

    // Steps 8-9: everything is distributed under R4; pending = cumulative − claimed per tokenId.
    const final = await rewards();
    t.expect(final.size).toBe(3);
    t.expect([...final.values()].every((r) => r.isRewardsDistributed && r.lastDistributedMerkleRoot === r4)).toBe(true);
    const pending = (tokenId: bigint) => final.get(tokenId)!.lastDistributedCumulativeReward - final.get(tokenId)!.claimed;
    t.expect(final.get(44n)!.wallet_id).toBe(wallet(DAVE));
    t.expect(pending(44n)).toBe(HALF + HALF); // Carol's unclaimed day 2 + Dave's day 4
    t.expect(pending(43n)).toBe(FULL + HALF);
    t.expect(pending(42n)).toBe(0n);

    // Conservation: four daily pools, minus at most one wei of dust per earner per run.
    const total = [...final.values()].reduce((sum, r) => sum + r.cumulativeReward, 0n);
    t.expect(total <= 4n * FULL).toBe(true);
    t.expect(4n * FULL - total <= 3n + 2n + 2n + 2n).toBe(true);

    // One reward tree per daily run, each marked published by its Reward event.
    const sum = (totals: Record<string, bigint>) => Object.values(totals).reduce((a, b) => a + b, 0n);
    const trees = (await indexer.StakingPoolV4RewardTree.getAll()).sort((a, b) => a.blockNumber - b.blockNumber);
    t.expect(trees.map((tree) => tree.merkleRoot)).toEqual([r1, r2, r3, r4]);
    t.expect(trees.map((tree) => tree.blockNumber)).toEqual([1, 2, 3, 4].map(dayBlock));
    t.expect(trees.map((tree) => tree.leafCount)).toEqual([3, 3, 3, 3]);
    t.expect(trees.map((tree) => tree.totalCumulativeReward)).toEqual([day1, day2, day3, day4].map(sum));
    t.expect(trees.map((tree) => tree.dailyReward)).toEqual([3n * THIRD, 2n * HALF, FULL, 2n * HALF]);
    t.expect(trees.every((tree) => tree.isPublished && tree.publishedAmount === FULL)).toBe(true);
    t.expect(trees.map((tree) => tree.publishedTransactionHash)).toEqual(
      [1, 2, 3, 4].map((day) => `0x${(dayBlock(day) + 10).toString(16).padStart(64, '0')}`),
    );
  });

  it('does not produce a new root when no staked position is in range', async (t) => {
    const r1 = rootOf({ '43': FULL });
    const changes = await run(
      dayBlock(2),
      deposit(dayBlock(1) - 10, BOB, 43n),
      publishRoot(dayBlock(1) + 10, r1),
      swapToTick(dayBlock(1) + 20, OUT_OF_NARROW_RANGE_TICK),
    );

    t.expect(rewardSetsAt(changes, dayBlock(2))).toHaveLength(0);
    t.expect((await indexer.StakingPoolV4RewardTree.getAll()).map((tree) => tree.merkleRoot)).toEqual([r1]);
    const record = (await rewards()).get(43n)!;
    t.expect(record.cumulativeReward).toBe(FULL);
    t.expect(record.merkleRoot).toBe(r1);
    t.expect(record.isRewardsDistributed).toBe(true);
  });

  it('burns update the tokenId record even when sent by an unrelated address', async (t) => {
    await run(
      dayBlock(1) + 1,
      deposit(dayBlock(1) - 10, ALICE, 42n),
      stakingEvent('RewardsBurned', dayBlock(1) + 1, { tokenId: 42n, amount: 5n }),
    );

    const records = await indexer.UserCumulativeReward.getAll();
    t.expect(records.map((r) => [r.id, r.burned])).toEqual([[rewardId(42n), 5n]]);
    const burn = (await indexer.StakingPoolV4PositionRecord.getAll()).find((r) => r.transactionType === 'REWARDS_BURNED');
    t.expect(burn?.wallet_id).toBe(wallet(ALICE));
    t.expect(burn?.stakingPosition_id).toBe(`${CHAIN_ID}-${ALICE}-42`);

    // The day 1 tree was never published.
    const [tree] = await indexer.StakingPoolV4RewardTree.getAll();
    t.expect(tree?.isPublished).toBe(false);
    t.expect(tree?.publishedAmount).toBeUndefined();
  });

  it('a resold, unstaked NFT is claimed by its new holder', async (t) => {
    await run(
      dayBlock(1) + 13,
      deposit(dayBlock(1) - 10, CAROL, 44n),
      publishRoot(dayBlock(1) + 10, rootOf({ '44': FULL })),
      stakingEvent('Withdraw', dayBlock(1) + 11, { owner: CAROL, tokenId: 44n, liquidity: 10n ** 18n }, CAROL),
      nftTransfer(dayBlock(1) + 12, CAROL, DAVE, 44n),
      claim(dayBlock(1) + 13, 44n, FULL),
    );

    const record = (await rewards()).get(44n)!;
    t.expect(record.wallet_id).toBe(wallet(DAVE));
    t.expect(record.claimed).toBe(FULL);
    const history = (await indexer.StakingPoolV4PositionRecord.getAll()).find((r) => r.transactionType === 'REWARDS_CLAIMED');
    t.expect(history?.wallet_id).toBe(wallet(DAVE));
    // Dave never staked #44: the claim links to Carol's position, which earned the rewards.
    t.expect(history?.stakingPosition_id).toBe(`${CHAIN_ID}-${CAROL}-44`);
  });
});
