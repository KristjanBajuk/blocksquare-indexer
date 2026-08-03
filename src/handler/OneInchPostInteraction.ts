import { indexer } from 'envio';
import { uint256ToAddress, updatePropertyTokenTradeCounts } from '../helper/LimitOrderTrades';
import { LimitOrderProtocol } from '../types/enums';

indexer.onEvent(
  { contract: 'OneInchPostInteraction', event: 'PostInteractionOrderFilled' },
  async ({ event, context }) => {
    // The 1inch Order struct fields (makerAsset, takerAsset, maker) are ABI-typed as uint256
    // but semantically hold packed addresses. In V2, Envio decoded tuples as positional arrays
    // requiring index constants (ORDER_STRUCT_INDEX.MAKER_ASSET). In V3, Solidity struct
    // components are decoded as named objects, so we access fields directly by name.
    // See: https://docs.envio.dev/docs/HyperIndex/whats-new-in-v3#better-tuples-developer-experience
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

    const tradeId = `${event.chainId}-${propertyToken.contractAddress}-${event.transaction.hash}-${event.logIndex}`;
    const buyerWalletId = `${event.chainId}-${event.params.taker}`;
    const marketplaceId = propertyToken.certifiedPartner_id;

    const extraData = event.params.extraData;
    const hasValidExtraData = extraData && extraData.length === 66;

    let validReferralCode = '';

    if (hasValidExtraData) {
      const userBytes = extraData.slice(2);
      const referrerUserId = `${event.chainId}-${userBytes}`;
      const referralId = `${event.chainId}-${marketplaceId}-${event.params.taker}`;

      const [referrerUser, buyerWalletEntity, existingReferral] = await Promise.all([
        context.User.get(referrerUserId),
        context.Wallet.get(buyerWalletId),
        context.Referral.get(referralId),
      ]);

      if (referrerUser && buyerWalletEntity?.user_id !== referrerUserId) {
        validReferralCode = extraData;

        if (!existingReferral) {
          context.Referral.set({
            id: referralId,
            wallet_id: buyerWalletId,
            referrer_id: referrerUserId,
            marketplace_id: marketplaceId,
            firstOrderTrade_id: tradeId,
            createdAt: event.block.timestamp,
          });
        }
      }
    }

    context.PropertyTokenTrade.set({
      id: tradeId,
      chainID: event.chainId,
      transactionHash: event.transaction.hash,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      propertyToken_id: propertyToken.id,
      maker_id: `${event.chainId}-${maker}`,
      taker_id: buyerWalletId,
      orderHash: event.params.orderHash,
      makerToken: makerToken,
      takerToken: takerToken,
      takerTokenFilledAmount: event.params.takingAmount,
      makerTokenFilledAmount: event.params.makingAmount,
      propertyValuation: propertyToken.propertyValuation,
      protocol: LimitOrderProtocol.OneInch,
      referralCode: validReferralCode,
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
