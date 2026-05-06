import { BigDecimal, UniswapPoolV2, onBlock } from 'generated';
import { getLoadedConfig } from '../config';
import { formatTo8Decimals } from '../helper/format';
import { ZeroAddress } from 'ethers';
import { getDay, getHour } from '../helper/date';
import { getAssetPairData, getNewAssetPairPrice, getNewUniswapV2Pool, getLPAssetPairData } from '../helper/UniswapPoolV2';

const config = getLoadedConfig();

// Recent anchor: block 25028441 = Unix 1777979735 (2026-05-05), ~12s per block
// Using a recent anchor avoids drift from missed-slot accumulation since the merge.
const ANCHOR_BLOCK = 25028441;
const ANCHOR_TIMESTAMP = 1777979735;
const BLOCKS_PER_HOUR = 300; // 3600s / 12s per block

const estimateTimestamp = (blockNumber: number): number =>
  ANCHOR_TIMESTAMP + (blockNumber - ANCHOR_BLOCK) * 12;

const uniswapWethBstPoolAddress = config.uniswapPoolContracts.find(
  (contract) => contract.assetPairId === 'BST/ETH',
)?.address;

const uniswapBstPointPoolAddress = config.uniswapPoolContracts.find(
  (contract) => contract.assetPairId === 'BST/POINT',
)?.address;

const poolAssetPairId = (address: string): string | undefined =>
  config.uniswapPoolContracts.find((c) => c.address === address)?.assetPairId;

UniswapPoolV2.Swap.handler(async ({ event, context }) => {
  const [ethUSDAssetPair, bstUSDAssetPair] = await Promise.all([
    context.AssetPair.get('ETH/USD'),
    context.AssetPair.get('BST/USD'),
  ]);

  if (ethUSDAssetPair) {
    //ETH:USD

    if (event.srcAddress === uniswapWethBstPoolAddress) {
      // BST:ETH Liquidity Pool
      // BST price calculation only
      const amount0In = BigDecimal(event.params.amount0In.toString());
      const amount1In = BigDecimal(event.params.amount1In.toString());
      const amount0Out = BigDecimal(event.params.amount0Out.toString());
      const amount1Out = BigDecimal(event.params.amount1Out.toString());

      // We need to check on which side of the swap BST is and calculate the price accordingly
      const bstToEth = amount0In.gt(0) ? amount1Out.div(amount0In) : amount1In.div(amount0Out);

      const bstToUsdPrecise = bstToEth.multipliedBy(ethUSDAssetPair.latestPrice);

      const { formatted: bstToUsd, formattedBI: bstToUsdBI } = formatTo8Decimals(bstToUsdPrecise);

      const assetPairId = 'BST/USD';
      const { start: hourStart } = getHour(event.block.timestamp);
      const { start: dayStart } = getDay(event.block.timestamp);

      const assetPairPrice = getNewAssetPairPrice(
        event.srcAddress,
        event.block.timestamp,
        event.block.number,
        event.logIndex,
        assetPairId,
        bstToUsdBI,
        bstToUsd,
        dayStart,
        hourStart,
      );
      context.AssetPairPrice.set(assetPairPrice);

      context.AssetPair.set({
        id: assetPairId,
        latestPrice: assetPairPrice.price,
        latestPriceBI: assetPairPrice.priceBI,
        updatedAt: event.block.timestamp,
        latestAggregatorAddress: ZeroAddress,
      });
    }

    if (bstUSDAssetPair) {
      if (event.srcAddress === uniswapBstPointPoolAddress) {
        // BST:POINT Liquidity Pool
        let { assetPairPrice, assetPairId } = getAssetPairData(bstUSDAssetPair, 'POINT', event);

        context.AssetPairPrice.set(assetPairPrice);

        context.AssetPair.set({
          id: assetPairId,
          latestPrice: assetPairPrice.price,
          latestPriceBI: assetPairPrice.priceBI,
          updatedAt: event.block.timestamp,
          latestAggregatorAddress: ZeroAddress,
        });
      }
    }
  }
});

// Track LP token total supply via mint (from=0x0) and burn (to=0x0) transfers
UniswapPoolV2.Transfer.handler(async ({ event, context }) => {
  const isMint = event.params.from === ZeroAddress;
  const isBurn = event.params.to === ZeroAddress;
  if (!isMint && !isBurn) return;

  const assetPairId = poolAssetPairId(event.srcAddress);
  if (!assetPairId) return;

  const pool =
    (await context.UniswapV2Pool.get(event.srcAddress)) ??
    getNewUniswapV2Pool(event.srcAddress, assetPairId);

  context.UniswapV2Pool.set({
    ...pool,
    totalSupply: isMint
      ? pool.totalSupply + event.params.value
      : pool.totalSupply - event.params.value,
  });
});

// On every reserve change, compute and store LP token price in USD
UniswapPoolV2.Sync.handler(async ({ event, context }) => {
  const pool = await context.UniswapV2Pool.get(event.srcAddress);
  if (!pool || pool.totalSupply === 0n) return;

  const updatedPool = {
    ...pool,
    reserve0: event.params.reserve0,
    reserve1: event.params.reserve1,
  };
  context.UniswapV2Pool.set(updatedPool);

  const { start: hourStart } = getHour(event.block.timestamp);
  const { start: dayStart } = getDay(event.block.timestamp);

  if (event.srcAddress === uniswapWethBstPoolAddress) {
    const [ethUSD, bstUSD] = await Promise.all([
      context.AssetPair.get('ETH/USD'),
      context.AssetPair.get('BST/USD'),
    ]);
    if (!ethUSD || !bstUSD) return;
    const { assetPairPrice, assetPair } = getLPAssetPairData(
      updatedPool, bstUSD.latestPrice, ethUSD.latestPrice,
      event.block.timestamp, event.block.number, event.logIndex, dayStart, hourStart,
    );
    context.AssetPairPrice.set(assetPairPrice);
    context.AssetPair.set(assetPair);
  }

  if (event.srcAddress === uniswapBstPointPoolAddress) {
    const [bstUSD, pointUSD] = await Promise.all([
      context.AssetPair.get('BST/USD'),
      context.AssetPair.get('POINT/USD'),
    ]);
    if (!bstUSD || !pointUSD) return;
    const { assetPairPrice, assetPair } = getLPAssetPairData(
      updatedPool, bstUSD.latestPrice, pointUSD.latestPrice,
      event.block.timestamp, event.block.number, event.logIndex, dayStart, hourStart,
    );
    context.AssetPairPrice.set(assetPairPrice);
    context.AssetPair.set(assetPair);
  }
});

// Recalculate LP price every ~1 hour using latest USD asset pair prices,
// so AssetPairPrice stays current even when no Sync event fires for extended periods.
onBlock(
  { name: 'HourlyLPPriceUpdate', chain: 1, interval: BLOCKS_PER_HOUR },
  async ({ block, context }) => {
    const [wethBstPool, bstPointPool, ethUSD, bstUSD, pointUSD] = await Promise.all([
      uniswapWethBstPoolAddress ? context.UniswapV2Pool.get(uniswapWethBstPoolAddress) : null,
      uniswapBstPointPoolAddress ? context.UniswapV2Pool.get(uniswapBstPointPoolAddress) : null,
      context.AssetPair.get('ETH/USD'),
      context.AssetPair.get('BST/USD'),
      context.AssetPair.get('POINT/USD'),
    ]);

    if (context.isPreload) return;

    const timestamp = estimateTimestamp(block.number);
    const { start: hourStart } = getHour(timestamp);
    const { start: dayStart } = getDay(timestamp);

    if (wethBstPool && wethBstPool.totalSupply !== 0n && ethUSD && bstUSD) {
      const { assetPairPrice, assetPair } = getLPAssetPairData(
        wethBstPool, bstUSD.latestPrice, ethUSD.latestPrice, timestamp, block.number, 0, dayStart, hourStart,
      );
      context.AssetPairPrice.set(assetPairPrice);
      context.AssetPair.set(assetPair);
    }

    if (bstPointPool && bstPointPool.totalSupply !== 0n && bstUSD && pointUSD) {
      const { assetPairPrice, assetPair } = getLPAssetPairData(
        bstPointPool, bstUSD.latestPrice, pointUSD.latestPrice, timestamp, block.number, 0, dayStart, hourStart,
      );
      context.AssetPairPrice.set(assetPairPrice);
      context.AssetPair.set(assetPair);
    }
  },
);
