import { decodeEventLog, getAddress, type Address, type Hex } from 'viem';

import { identityRegistryAbi } from './abi';

/**
 * ERC-8004 Identity Registry access (path A: register seed agents in the
 * canonical registry; the minimal precondition for any feedback write).
 *
 * Two responsibilities, both forced by the live contract semantics:
 *
 * 1. **Registration** ({@link registerAgent}) — `IdentityRegistry.register(uri)`
 *    is a permissionless self-mint: `msg.sender` becomes the agent's owner and
 *    receives a fresh `uint256` tokenId. That tokenId is the `agentId` every
 *    feedback write is keyed by, so it must be persisted into
 *    `agents.agent_id_onchain`. The minted id is read back from the `Registered`
 *    event in the transaction receipt — never guessed.
 *
 * 2. **Authorization pre-check** ({@link assertCanAttest}) — the canonical
 *    `giveFeedback` reverts with `"Self-feedback not allowed"` when the sender
 *    `isAuthorizedOrOwner` of the agent, and with `ERC721NonexistentToken` when
 *    the agent was never registered. Both are checked here *before* a write so
 *    the failure is a deterministic, typed error instead of a wasted reverting
 *    transaction.
 *
 * The viem client is injected behind narrow interfaces (mirroring
 * `registry.ts`), so every outcome — existing/missing token, authorized/not,
 * register success/revert — is unit-testable without a network. The concrete
 * server-only adapters live in `client.ts`, where viem revert classification is
 * done once.
 */

/** Thrown on any invalid input or unexpected identity registry/RPC response. */
export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

/** Inclusive upper bound of a Solidity `uint256`. */
const UINT256_MAX = (1n << 256n) - 1n;
/** Defensive upper bound on an agent card URI (rejects pathological input). */
const MAX_AGENT_URI_LEN = 2_048;

/**
 * Read capability the identity helpers need. The adapter is responsible for
 * mapping a "token does not exist" contract revert to `null`/`false` (so this
 * layer never has to classify viem errors) while letting transport failures
 * propagate as thrown errors.
 */
export interface IdentityReader {
  /** Owner of `agentId`, or `null` if the token has never been registered. */
  ownerOf(agentId: bigint): Promise<Address | null>;
  /** Whether `spender` is owner/operator/approved for `agentId`; `false` if missing. */
  isAuthorizedOrOwner(spender: Address, agentId: bigint): Promise<boolean>;
}

/** A confirmed-receipt shape sufficient to decode the minted tokenId. */
export interface RegisterReceipt {
  readonly status: 'success' | 'reverted';
  readonly logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[];
}

/** Write capability for registration. Backed by the owner wallet (msg.sender). */
export interface IdentityWriteClient {
  /** Send `register(agentURI)`; resolves to the transaction hash. */
  writeRegister(agentURI: string): Promise<Hex>;
  /** Wait for the receipt of a sent registration transaction. */
  waitForReceipt(hash: Hex): Promise<RegisterReceipt>;
}

/** Normalize/validate a tokenId argument into a bounded `uint256`. */
function toAgentId(agentId: bigint): bigint {
  if (agentId < 0n || agentId > UINT256_MAX) {
    throw new IdentityError('agentId out of uint256 range');
  }
  return agentId;
}

/** Whether `agentId` is a registered token in the Identity Registry. */
export async function agentExists(reader: IdentityReader, agentId: bigint): Promise<boolean> {
  return (await reader.ownerOf(toAgentId(agentId))) !== null;
}

/**
 * Process-scoped cache for `ownerOf` results. Agent ownership is static once
 * registered (the token never changes owner in the demo arc), so caching the
 * `ownerOf` round-trip eliminates one RPC call per `submitAttestation` (A-05).
 * The `isAuthorizedOrOwner` call remains live for correctness.
 */
const ownerOfCache = new Map<bigint, Address>();

/**
 * Assert that `attestor` may leave feedback for `agentId` against the canonical
 * registry, failing closed before any write:
 * - the agent must be registered (else `giveFeedback` reverts on a missing token);
 * - the attestor must NOT be the agent's owner/operator/approved address (else
 *   the registry rejects it as self-feedback).
 *
 * This is the deterministic guard for the two-key model: the owner key
 * registers agents, a *separate* attestor key writes feedback.
 *
 * `ownerOf` results are cached process-wide (A-05) since ownership is static.
 */
export async function assertCanAttest(
  reader: IdentityReader,
  attestor: Address,
  agentId: bigint,
): Promise<void> {
  const id = toAgentId(agentId);
  let owner = ownerOfCache.get(id);
  if (owner === undefined) {
    const fetched = await reader.ownerOf(id);
    if (fetched === null) {
      throw new IdentityError('agent is not registered in the Identity Registry');
    }
    ownerOfCache.set(id, fetched);
    owner = fetched;
  }
  if (await reader.isAuthorizedOrOwner(attestor, id)) {
    throw new IdentityError(
      'attestor is the agent owner/operator — the registry rejects self-feedback; use a separate attestor key',
    );
  }
}

/**
 * Clear the `ownerOf` process cache. **Test-only**: because the cache is a
 * process singleton, tests that supply a fake reader must clear it between runs
 * to avoid stale hits. Not for production use.
 */
export function resetOwnerOfCacheForTest(): void {
  ownerOfCache.clear();
}

/** Validate an agent card URI argument for {@link registerAgent}. */
function validateAgentUri(agentURI: string): string {
  if (typeof agentURI !== 'string') {
    throw new IdentityError('agentURI must be a string');
  }
  if (agentURI.length > MAX_AGENT_URI_LEN) {
    throw new IdentityError('agentURI exceeds maximum length');
  }
  return agentURI;
}

/**
 * Register a new agent and return its freshly minted tokenId (the `agentId` to
 * persist into `agents.agent_id_onchain`). The id is decoded from the
 * `Registered` event emitted by the identity registry in the confirmed receipt;
 * a reverted transaction or a receipt without that event is a typed failure, so
 * a caller never persists a guessed id.
 */
export async function registerAgent(
  client: IdentityWriteClient,
  identityAddress: Address,
  agentURI: string,
): Promise<bigint> {
  const uri = validateAgentUri(agentURI);
  const registry = getAddress(identityAddress);

  const hash = await client.writeRegister(uri);
  const receipt = await client.waitForReceipt(hash);
  if (receipt.status !== 'success') {
    throw new IdentityError('register transaction reverted');
  }

  for (const log of receipt.logs) {
    let logAddress: Address;
    try {
      logAddress = getAddress(log.address);
    } catch {
      continue;
    }
    if (logAddress !== registry) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: identityRegistryAbi,
        eventName: 'Registered',
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      return decoded.args.agentId;
    } catch {
      // Not the Registered event (e.g. the MetadataSet log) — keep scanning.
    }
  }

  throw new IdentityError('register receipt contained no decodable Registered event');
}
