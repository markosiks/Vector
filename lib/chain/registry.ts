import { getAddress, type Address, type Hex } from 'viem';

/**
 * Read wrapper over the canonical ERC-8004 Reputation Registry (P1.7).
 *
 * The functions here are the *only* way the app touches the registry on the
 * read path. They take a {@link ReputationReader} rather than a concrete viem
 * client, which is the dependency-injection seam that lets unit/fuzz tests drive
 * every RPC outcome (success, malformed payload, revert, timeout) without a
 * network, exactly like the db repos take a `Queryable`. The server-only
 * adapter that binds a real viem `PublicClient` to the configured address lives
 * in `client.ts`.
 *
 * Security/robustness invariants:
 * - Every untrusted caller input (`agentId`, client address, feedback index) is
 *   range/format-checked *before* it reaches the RPC, so a malformed argument is
 *   a deterministic {@link RegistryError}, never an ABI-encoding panic.
 * - Every value coming *back* from the RPC is treated as untrusted: shapes are
 *   validated, so a flapping/hostile endpoint yields a typed error rather than
 *   `undefined` leaking into the app.
 */

/** Read-only function names on the registry ABI that this wrapper invokes. */
export type RegistryReadFn =
  | 'getIdentityRegistry'
  | 'getVersion'
  | 'getClients'
  | 'getLastIndex'
  | 'getSummary'
  | 'readFeedback';

/**
 * The minimal capability the read wrapper needs from a chain client. Kept
 * deliberately narrow so a test can implement it with a plain object and so the
 * registry layer never depends on viem's full surface.
 */
export interface ReputationReader {
  /** `eth_getCode` at an address. `undefined` or `'0x'` means no contract. */
  getCode(address: Address): Promise<Hex | undefined>;
  /** A typed read against the registry, already bound to its address + ABI. */
  readContract(functionName: RegistryReadFn, args: readonly unknown[]): Promise<unknown>;
}

/** Thrown on any invalid input or unexpected registry/RPC response. */
export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

/** Inclusive upper bound of a Solidity `uint256`. */
const UINT256_MAX = (1n << 256n) - 1n;
/** Inclusive upper bound of a Solidity `uint64`. */
const UINT64_MAX = (1n << 64n) - 1n;

/** Normalize an arbitrary numeric-ish input into a bounded unsigned integer. */
function toUint(label: string, value: bigint | number | string, max: bigint): bigint {
  let n: bigint;
  try {
    n = typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    throw new RegistryError(`${label} must be an integer`);
  }
  if (n < 0n || n > max) {
    throw new RegistryError(`${label} out of range`);
  }
  return n;
}

/**
 * Coerce an untrusted registry numeric return into a bigint, failing closed.
 *
 * Decoded RPC tuple elements are typed by the ABI in production, but this
 * wrapper treats every reader return as untrusted (the reader is injected). A
 * non-numeric element must surface as a typed {@link RegistryError}, never a
 * bare `TypeError` escaping `BigInt(...)`.
 */
function toBigIntField(label: string, value: unknown): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'string') {
    try {
      return BigInt(value);
    } catch {
      throw new RegistryError(`${label} must be an integer`);
    }
  }
  throw new RegistryError(`${label} must be an integer`);
}

/** Coerce an untrusted registry return into a bounded unsigned integer, failing closed. */
function toUintField(label: string, value: unknown, max: bigint): bigint {
  const n = toBigIntField(label, value);
  if (n < 0n || n > max) {
    throw new RegistryError(`${label} out of range`);
  }
  return n;
}

/** Coerce an untrusted decimals return into a uint8-bounded number, failing closed. */
function toDecimals(label: string, value: unknown): number {
  return Number(toUintField(label, value, 255n));
}

/** Validate + checksum an address argument; rejects malformed input cleanly. */
function toAddress(label: string, value: string): Address {
  try {
    return getAddress(value);
  } catch {
    throw new RegistryError(`${label} must be a valid EVM address`);
  }
}

/** Decoded one-feedback record from {@link readFeedback}. */
export interface FeedbackRecord {
  readonly value: bigint;
  readonly valueDecimals: number;
  readonly tag1: string;
  readonly tag2: string;
  readonly isRevoked: boolean;
}

/** Decoded aggregate from {@link getAgentSummary}. */
export interface FeedbackSummary {
  readonly count: bigint;
  readonly value: bigint;
  readonly valueDecimals: number;
}

/** Result of {@link smokeRead}: proof the registry is live and readable. */
export interface SmokeReadResult {
  readonly address: Address;
  readonly deployed: boolean;
  readonly identityRegistry: Address;
  readonly version: string;
}

/** Enumerate the client addresses that have left feedback for `agentId`. */
export async function getClients(
  reader: ReputationReader,
  agentId: bigint | number | string,
): Promise<Address[]> {
  const id = toUint('agentId', agentId, UINT256_MAX);
  const result = await reader.readContract('getClients', [id]);
  if (!Array.isArray(result)) {
    throw new RegistryError('getClients returned a non-array');
  }
  return result.map((a, i) => toAddress(`client[${i}]`, a as string));
}

/** Assert a contract is actually deployed at `address` (non-empty bytecode). */
export async function assertDeployed(reader: ReputationReader, address: Address): Promise<void> {
  const code = await reader.getCode(address);
  if (code === undefined || code === '0x') {
    throw new RegistryError('no contract deployed at registry address');
  }
}

/** Read the Identity Registry the reputation contract is wired to. */
export async function getIdentityRegistry(reader: ReputationReader): Promise<Address> {
  const result = await reader.readContract('getIdentityRegistry', []);
  if (typeof result !== 'string') {
    throw new RegistryError('getIdentityRegistry returned a non-address');
  }
  return toAddress('identityRegistry', result);
}

/** Read the registry's semantic version string. */
export async function getVersion(reader: ReputationReader): Promise<string> {
  const result = await reader.readContract('getVersion', []);
  if (typeof result !== 'string') {
    throw new RegistryError('getVersion returned a non-string');
  }
  return result;
}

/**
 * Smoke-read the registry: prove there is code at the address and that it
 * answers two canonical reads. This is the P1.7 Definition-of-Done check — a
 * working, readable Reputation Registry reachable from the app.
 */
export async function smokeRead(
  reader: ReputationReader,
  address: Address,
): Promise<SmokeReadResult> {
  await assertDeployed(reader, address);
  const [identityRegistry, version] = await Promise.all([
    getIdentityRegistry(reader),
    getVersion(reader),
  ]);
  return { address, deployed: true, identityRegistry, version };
}

/** The latest feedback index written by `client` for `agentId` (0 if none). */
export async function getLastIndex(
  reader: ReputationReader,
  agentId: bigint | number | string,
  client: string,
): Promise<bigint> {
  const id = toUint('agentId', agentId, UINT256_MAX);
  const addr = toAddress('client', client);
  const result = await reader.readContract('getLastIndex', [id, addr]);
  return toUint('lastIndex', result as bigint, UINT64_MAX);
}

/**
 * Aggregate feedback for an agent over an explicit, non-empty set of client
 * addresses, optionally narrowed by tags.
 *
 * The canonical contract has no "all clients" sentinel — it reverts on an empty
 * `clientAddresses` array ("clientAddresses required") — so this wrapper rejects
 * an empty set client-side as a deterministic {@link RegistryError} rather than
 * paying for a revert. Callers that want "every client" should first call
 * {@link getClients} and pass the result.
 */
export async function getAgentSummary(
  reader: ReputationReader,
  agentId: bigint | number | string,
  clients: readonly string[],
  tag1 = '',
  tag2 = '',
): Promise<FeedbackSummary> {
  const id = toUint('agentId', agentId, UINT256_MAX);
  if (clients.length === 0) {
    throw new RegistryError('getSummary requires at least one client address');
  }
  const addrs = clients.map((c, i) => toAddress(`client[${i}]`, c));
  const result = await reader.readContract('getSummary', [id, addrs, tag1, tag2]);
  if (!Array.isArray(result) || result.length < 3) {
    throw new RegistryError('getSummary returned an unexpected shape');
  }
  const [count, value, decimals] = result;
  return {
    count: toUintField('summary.count', count, UINT64_MAX),
    value: toBigIntField('summary.value', value),
    valueDecimals: toDecimals('summary.valueDecimals', decimals),
  };
}

/** Read a single feedback record by `(agentId, client, index)`. */
export async function readFeedback(
  reader: ReputationReader,
  agentId: bigint | number | string,
  client: string,
  index: bigint | number | string,
): Promise<FeedbackRecord> {
  const id = toUint('agentId', agentId, UINT256_MAX);
  const addr = toAddress('client', client);
  const idx = toUint('feedbackIndex', index, UINT64_MAX);
  const result = await reader.readContract('readFeedback', [id, addr, idx]);
  if (!Array.isArray(result) || result.length < 5) {
    throw new RegistryError('readFeedback returned an unexpected shape');
  }
  const [value, valueDecimals, tag1, tag2, isRevoked] = result;
  if (typeof tag1 !== 'string' || typeof tag2 !== 'string') {
    throw new RegistryError('readFeedback returned non-string tags');
  }
  if (typeof isRevoked !== 'boolean') {
    throw new RegistryError('readFeedback returned a non-boolean revocation flag');
  }
  return {
    value: toBigIntField('feedback.value', value),
    valueDecimals: toDecimals('feedback.valueDecimals', valueDecimals),
    tag1,
    tag2,
    isRevoked,
  };
}
