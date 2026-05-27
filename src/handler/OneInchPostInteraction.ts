import { indexer } from 'envio';
import { uint256ToAddress, updatePropertyTokenTradeCounts } from '../helper/LimitOrderTrades';
import { LimitOrderProtocol } from '../types/enums';

indexer.onEvent(
  { contract: 'OneInchPostInteraction', event: 'PostInteractionOrderFilled' },
  async ({ event, context }) => {
    // In V3, order struct uses named fields (makerAsset, takerAsset, maker are uint256/bigint)
    const makerToken = uint256ToAddress(event.params.order.makerAsset);
    const takerToken = uint256ToAddress(event.params.order.takerAsset);
    const maker = uint256ToAddress(event.params.order.maker);

    // Check if either makerToken or takerToken is a property token
    const [makerPropertyToken, takerPropertyToken] = await Promise.all([
      context.PropertyToken.get(`${event.chainId}-${makerToken}`),
      context.PropertyToken.get(`${event.chainId}-${takerToken}`),
    ]);

    // Determine which property token to use (at least one must exist)
    const propertyToken = makerPropertyToken || takerPropertyToken;
    if (!propertyToken) {
      return;
    }

    context.PropertyTokenTrade.set({
      id: `${event.chainId}-${propertyToken.contractAddress}-${event.transaction.hash}-${event.logIndex}`,
      chainID: event.chainId,
      transactionHash: event.transaction.hash,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      propertyToken_id: propertyToken.id,
      maker_id: `${event.chainId}-${maker}`,
      taker_id: `${event.chainId}-${event.params.taker}`,
      orderHash: event.params.orderHash,
      makerToken: makerToken,
      takerToken: takerToken,
      takerTokenFilledAmount: event.params.takingAmount,
      makerTokenFilledAmount: event.params.makingAmount,
      propertyValuation: propertyToken.propertyValuation,
      protocol: LimitOrderProtocol.OneInch,
    });

    // Handle case where property token is on maker side (being sold)
    if (makerPropertyToken) {
      context.PropertyToken.set({
        ...makerPropertyToken,
        totalPropertyTokenTraded:
          makerPropertyToken.totalPropertyTokenTraded + event.params.makingAmount,
        totalValueTraded: makerPropertyToken.totalValueTraded + event.params.takingAmount,
      });
    }

    // Handle case where property token is on taker side (being bought)
    if (takerPropertyToken) {
      context.PropertyToken.set({
        ...takerPropertyToken,
        totalPropertyTokenTraded:
          takerPropertyToken.totalPropertyTokenTraded + event.params.takingAmount,
        totalValueTraded: takerPropertyToken.totalValueTraded + event.params.makingAmount,
      });
    }

    await updatePropertyTokenTradeCounts(context, event.chainId, maker, 'makerCount');
    await updatePropertyTokenTradeCounts(context, event.chainId, event.params.taker, 'takerCount');
  },
);
