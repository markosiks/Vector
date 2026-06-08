import type { Address, PublicClient, Transport, Chain } from 'viem';

import { REPUTATION_REGISTRY_ABI } from './abi/reputation-registry';
import { TESTNET_REPUTATION_REGISTRY } from './addresses';

/**
 * Pure read helpers for the ERC-8004 Reputation Registry on Mantle Sepolia.
 *
 * Every function takes a `PublicClient` as its first argument so callers can
 * inject a test double (mock transport, local fork) without touching the
 * singleton. In production the caller passes `getPublicClient()`.
 *
 * None of these functions perform writes or need a wallet client.
 */

/** The registry address used by all read helpers (canonical testnet singleton). */
export const REGISTRY_ADDRESS = TESTNET_REPUTATION_REGISTRY;

// ── Types ─────────────────────────────────────────────────────────────────

export interface FeedbackEntry {
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  isRevoked: boolean;
}

export interface FeedbackSummary {
  count: bigint;
  summaryValue: bigint;
  summaryValueDecimals: number;
}

// ── Reads ─────────────────────────────────────────────────────────────────

/**
 * Smoke-read: fetch the Identity Registry address the Reputation Registry is
 * bound to. This is the simplest possible read — if it succeeds, the registry
 * is live and reachable.
 */
export async function getIdentityRegistry(
  client: PublicClient<Transport, Chain>,
  registryAddress: Address = REGISTRY_ADDRESS,
): Promise<Address> {
  const result = await client.readContract({
    address: registryAddress,
    abi: REPUTATION_REGISTRY_ABI,
    functionName: 'getIdentityRegistry',
  });
  return result as Address;
}

/**
 * Read a single feedback entry by (agentId, clientAddress, feedbackIndex).
 *
 * feedbackIndex is 1-indexed per the ERC-8004 spec.
 */
export async function readFeedback(
  client: PublicClient<Transport, Chain>,
  agentId: bigint,
  clientAddress: Address,
  feedbackIndex: bigint,
  registryAddress: Address = REGISTRY_ADDRESS,
): Promise<FeedbackEntry> {
  const result = await client.readContract({
    address: registryAddress,
    abi: REPUTATION_REGISTRY_ABI,
    functionName: 'readFeedback',
    args: [agentId, clientAddress, feedbackIndex],
  });

  const [value, valueDecimals, tag1, tag2, isRevoked] = result as [
    bigint,
    number,
    string,
    string,
    boolean,
  ];
  return { value, valueDecimals, tag1, tag2, isRevoked };
}

/**
 * Read an aggregated summary of feedback for an agent, optionally filtered
 * by client addresses and tags.
 */
export async function getSummary(
  client: PublicClient<Transport, Chain>,
  agentId: bigint,
  opts: {
    clientAddresses?: Address[];
    tag1?: string;
    tag2?: string;
  } = {},
  registryAddress: Address = REGISTRY_ADDRESS,
): Promise<FeedbackSummary> {
  const result = await client.readContract({
    address: registryAddress,
    abi: REPUTATION_REGISTRY_ABI,
    functionName: 'getSummary',
    args: [
      agentId,
      opts.clientAddresses ?? [],
      opts.tag1 ?? '',
      opts.tag2 ?? '',
    ],
  });

  const [count, summaryValue, summaryValueDecimals] = result as [bigint, bigint, number];
  return { count, summaryValue, summaryValueDecimals };
}

/**
 * Fetch recent `NewFeedback` events for an agent from the registry.
 *
 * Uses `eth_getLogs` via viem's `getContractEvents`. The `fromBlock` defaults
 * to the Mantle Sepolia deploy block of the registry.
 */
export async function getNewFeedbackEvents(
  client: PublicClient<Transport, Chain>,
  agentId: bigint,
  opts: {
    fromBlock?: bigint;
    toBlock?: bigint | 'latest';
  } = {},
  registryAddress: Address = REGISTRY_ADDRESS,
) {
  const { MANTLE_SEPOLIA_REPUTATION_DEPLOY_BLOCK } = await import('./addresses');
  return client.getContractEvents({
    address: registryAddress,
    abi: REPUTATION_REGISTRY_ABI,
    eventName: 'NewFeedback',
    args: { agentId },
    fromBlock: opts.fromBlock ?? MANTLE_SEPOLIA_REPUTATION_DEPLOY_BLOCK,
    toBlock: opts.toBlock ?? 'latest',
  });
}

/**
 * One-shot smoke test: read `getIdentityRegistry()` and return a diagnostic
 * object. Catches transport/RPC errors and returns them as a structured
 * failure rather than throwing, so the health endpoint can report degraded
 * without crashing.
 */
export async function smokeRead(
  client: PublicClient<Transport, Chain>,
  registryAddress: Address = REGISTRY_ADDRESS,
): Promise<
  | { ok: true; identityRegistry: Address; registryAddress: Address }
  | { ok: false; error: string; registryAddress: Address }
> {
  try {
    const identityRegistry = await getIdentityRegistry(client, registryAddress);
    return { ok: true, identityRegistry, registryAddress };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, registryAddress };
  }
}
