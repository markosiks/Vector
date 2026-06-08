import { keccak256, encodePacked, type Address, type Hex } from 'viem';

import { CONFIG } from '@/lib/config/constants';
import { TESTNET_IDENTITY_REGISTRY } from './addresses';

/**
 * agent_id_onchain provenance — deterministic assignment for seed agents.
 *
 * ## Context (P1.7 §4.5)
 *
 * The Identity Registry and Identity-NFT are [ROADMAP] (out of scope for
 * [CORE]). Without an on-chain Identity Registry mint, there is no canonical
 * ERC-721 `tokenId` for each agent.
 *
 * To unblock P1.8 (on-chain feedback writes), the **operator assigns** each
 * seed agent a deterministic `agent_id_onchain`. This ID is:
 *
 * 1. Derived deterministically from the agent's stable `id` (e.g. `seed-leader`)
 *    and the operator's address, so it is reproducible across runs.
 * 2. Stored in `agents.agent_id_onchain` (the existing nullable text column).
 * 3. Used as the `agentId` parameter in `giveFeedback` calls.
 *
 * When the Identity Registry is adopted ([ROADMAP]), the operator will mint
 * real ERC-721 tokens and update `agent_id_onchain` to the minted `tokenId`.
 * Until then, this deterministic ID is a placeholder that preserves the
 * feedback write flow.
 *
 * ## Derivation
 *
 * ```
 * agent_id_onchain = uint256(keccak256(abi.encodePacked(
 *   "vector-agent-v1",
 *   operatorAddress,
 *   agentStableId       // e.g. "seed-leader"
 * )))
 * ```
 *
 * The `"vector-agent-v1"` prefix namespaces the derivation to avoid collisions
 * with other projects using the same pattern.
 */

const DERIVATION_PREFIX = 'vector-agent-v1';

/**
 * Derive a deterministic on-chain agent ID for a seed agent.
 *
 * @param agentStableId The agent's stable string identifier (e.g. `seed-leader`).
 * @param operatorAddress The operator's Ethereum address.
 * @returns A `bigint` suitable for use as the ERC-8004 `agentId` parameter.
 */
export function deriveAgentIdOnchain(agentStableId: string, operatorAddress: Address): bigint {
  const hash = keccak256(
    encodePacked(
      ['string', 'address', 'string'],
      [DERIVATION_PREFIX, operatorAddress, agentStableId],
    ),
  );
  return BigInt(hash);
}

/**
 * Build the full ERC-8004 `agentRegistry` string for Mantle Sepolia.
 *
 * Format: `eip155:{chainId}:{identityRegistryAddress}`
 *
 * Note: since the Identity Registry is [ROADMAP], this uses the canonical
 * testnet Identity Registry address as a forward-compatible placeholder.
 */
export function agentRegistryString(
  identityRegistry: Address = TESTNET_IDENTITY_REGISTRY,
): string {
  return `eip155:${CONFIG.chain.mantle_testnet_chain_id}:${identityRegistry}`;
}

/**
 * Format an `agent_id_onchain` bigint as a hex string for storage in the
 * `agents.agent_id_onchain` text column.
 */
export function formatAgentIdOnchain(agentId: bigint): string {
  return `0x${agentId.toString(16).padStart(64, '0')}`;
}

/**
 * Parse an `agent_id_onchain` text value back to a bigint.
 *
 * @throws if the value is not a valid hex string.
 */
export function parseAgentIdOnchain(value: string): bigint {
  if (!value.startsWith('0x') && !value.startsWith('0X')) {
    throw new Error(`Invalid agent_id_onchain: must start with 0x, got "${value}"`);
  }
  return BigInt(value);
}
