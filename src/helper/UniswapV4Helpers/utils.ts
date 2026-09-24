import { ethers, keccak256, parseUnits } from "ethers";
import { MerkleTree } from "merkletreejs";

// Total monthly rewards distributed to stakers in wei.
// TODO: this set to 300 for testing, we should replace this with the correct amount for mainnet
export const TOTAL_MONTHLY_REWARDS = parseUnits("300", 18);

// Daily reward amount = monthly / 30 (integer division).
export const TOTAL_DAILY_REWARDS = TOTAL_MONTHLY_REWARDS / 30n;

// Precision factor for timeBoost values.
// A boost of 100 represents 1.0x (no boost), 122 = 1.22x, etc.
// Used to normalize boosted liquidity calculations.
export const BOOST_PRECISION = 100n;

const SEPOLIA_CHAIN_ID = 11155111;

/**
 * Builds a Merkle tree from an array of reward data (tokenId + cumulativeReward).
 * Each leaf is the keccak256 hash of (tokenId, cumulativeReward).
 *
 * @param positions - Array of objects containing tokenId and cumulativeReward.
 * @returns The Merkle tree instance, its hex root, and `proofs[i]`, the hex proof for `positions[i]`.
 */
export function buildMerkleTree(positions: Array<{ tokenId: bigint; cumulativeReward: bigint }>) {
  const leaves = positions.map(({ tokenId, cumulativeReward }) =>
    ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256"],
        [tokenId, cumulativeReward]
      )
    )
  );
  const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  // Proofs are looked up by leaf index. Looking them up by leaf hash scans every leaf per proof,
  // which is O(n²): about 20s for 50k records.
  const proofs = leaves.map((_, i) => tree.getHexProof(tree.getLeaf(i), i));
  return { tree, root: tree.getHexRoot(), proofs };
}

/** Comparator for sorting bigints ascending, e.g. `records.sort((a, b) => compareBigInt(a.tokenId, b.tokenId))`. */
export const compareBigInt = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Returns the predicted number of blocks per day for a given chain.
 * Used to schedule daily onBlock handlers.
 *
 * @param chainId - The chain ID
 * @returns Number of blocks expected in a 24-hour period.
 */
export const getPredictedDailyBlockCount = (chainId: number) => {
    return chainId === SEPOLIA_CHAIN_ID ? 7080 : 7200;
}

/**
 * Returns the block number at which the Uniswap V4 Staking contract was deployed
 * on the specified chain. Used as the startBlock for daily reward calculations.
 *
 * @param chainId - The chain ID.
 * @returns The deployment block number.
 */
export const getUniswapV4StakingDeployementBlock = (chainId: number) => {
    // TODO: Replace with mainnet deployment block when available.
    return chainId === SEPOLIA_CHAIN_ID ? 10245814 : 10245814;
}
// Uniswap V4 poolId = keccak256(abi.encode(PoolKey)).
export const computeV4PoolId = (
  currency0: string,
  currency1: string,
  fee: bigint,
  tickSpacing: bigint,
  hooks: string,
): string =>
  keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint24", "int24", "address"],
      [currency0, currency1, fee, tickSpacing, hooks],
    ),
  );
