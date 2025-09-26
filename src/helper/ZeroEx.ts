import { PropertyTokenTradeCounts } from 'generated';

export const getNewPropertyTokenTradeCounts = (
    chainId: number,
    walletId: string
): PropertyTokenTradeCounts => {
    return {
        id: `${chainId}-${walletId}`,
        chainId,
        takerCount: 0,
        makerCount: 0
    };
};

export const updatePropertyTokenTradeCounts = async (
    context: any,
    chainId: number,
    walletId: string,
    tradeType: "makerCount" | "takerCount"
) => {
    const propertyTokenTradeCounts = await context.PropertyTokenTradeCounts.get(
        `${chainId}-${walletId}`
    );

    if (!propertyTokenTradeCounts) {
        const newTradeCounts = getNewPropertyTokenTradeCounts(chainId, walletId);
        context.PropertyTokenTradeCounts.set({
            ...newTradeCounts,
            [tradeType]: 1,
        });
    } else {
        context.PropertyTokenTradeCounts.set({
            ...propertyTokenTradeCounts,
            [tradeType]: propertyTokenTradeCounts[tradeType] + 1,
        });
    }
}