import type { TestIndexer } from 'envio';
import { getAddress } from 'ethers';

export const CHAIN_ID = 11155111;

export const addr = (raw: string) => getAddress(raw) as `0x${string}`;

export const setPropertyToken = (
  indexer: TestIndexer,
  contractAddress: `0x${string}`,
  certifiedPartnerId: string,
) => {
  indexer.PropertyToken.set({
    id: `${CHAIN_ID}-${contractAddress}`,
    chainId: CHAIN_ID,
    contractAddress,
    name: 'Test Property',
    symbol: 'TP',
    totalSupply: 1_000_000n,
    totalBurnt: 0n,
    totalTransfers: 0,
    totalHolders: 0,
    tokenValuation: 0n,
    propertyValuation: 1_000_000n,
    propertyValuationUpdateTimestamp: 0,
    propertyValuationCurrency: 'USD',
    certifiedPartnerWallet_id: `${CHAIN_ID}-cpwallet`,
    streetLocation: '',
    geoLocation: '',
    lat: 0,
    lng: 0,
    countryCode: 'SI',
    parcelNumber: '',
    kadastralMunicipality: '',
    buildingPart: 0,
    propertyType: '',
    ipfs: '',
    createdAt: 0,
    createdAtBlock: 0,
    creationTransaction: '',
    totalPropertyTokenTraded: 0n,
    totalValueTraded: 0n,
    certifiedPartner_id: certifiedPartnerId,
    latestOffering_id: `${CHAIN_ID}-offering`,
    offeringV2_id: undefined,
    apy: 0,
    currentYearApy: 0,
    weightedNAVDeviation: 0,
  });
};
