import { User } from 'generated';

export const getNewUser = (chainId: number, userId: string): User => {
  return {
    id: `${chainId}-${userId}`,
    chainId,
  };
};
