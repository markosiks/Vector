import type { Address } from 'viem';

/**
 * ERC-8004 canonical per-chain singleton addresses.
 *
 * All testnet chains share the same CREATE2-deterministic pair.
 * Source: erc-8004.quicknode.com/docs/contracts (verified 2026-06-08).
 *
 * Mainnet addresses are included for reference but are NOT used in [CORE];
 * Vector operates exclusively on Mantle Sepolia testnet.
 */

// ── Testnet (CREATE2-deterministic, identical on every testnet) ───────────
export const TESTNET_IDENTITY_REGISTRY: Address =
  '0x8004A818BFB912233c491871b3d84c89A494BD9e';

export const TESTNET_REPUTATION_REGISTRY: Address =
  '0x8004B663056A597Dffe9eCcC1965A193B7388713';

export const TESTNET_VALIDATION_REGISTRY: Address =
  '0x8004Cb1BF31DAf7788923b405b754f57acEB4272';

// ── Mainnet (reference only — not used in [CORE]) ─────────────────────────
export const MAINNET_IDENTITY_REGISTRY: Address =
  '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

export const MAINNET_REPUTATION_REGISTRY: Address =
  '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';

/**
 * Mantle Sepolia specific — deploy block of the Reputation Registry.
 * Used as the `fromBlock` for event indexing so we skip empty ranges.
 */
export const MANTLE_SEPOLIA_REPUTATION_DEPLOY_BLOCK = 34_586_937n;
