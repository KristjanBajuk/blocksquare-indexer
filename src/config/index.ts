import type { Config } from '../types/config';
import { mainnetConfig } from './mainnet';
import { testnetConfig } from './testnet';

let loadedConfig: Config | null = null;

export const getLoadedConfig = (): Config => {
  if (!loadedConfig) {
    const network = process.env.ENVIO_NETWORK || 'testnet';
    console.log('Loaded config:', network);
    loadedConfig = network === 'mainnet' ? mainnetConfig : testnetConfig;
  }
  return loadedConfig;
};
