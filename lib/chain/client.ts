import 'server-only';

import {
  BaseError,
  ContractFunctionExecutionError,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';

import { CONFIG } from '../config/constants';
import { ENV } from '../config/env';
import { identityRegistryAbi, reputationRegistryAbi } from './abi';
import { IdentityError, type IdentityReader, type IdentityWriteClient } from './identity';
import { mantleSepolia } from './network';
import {
  assertDistinctSignerKeys,
  operatorAddress,
  parseAttestorKey,
  parseOperatorKey,
} from './operator.schema';
import { privateKeyToAccount } from 'viem/accounts';
import type { RegistryReadFn, ReputationReader } from './registry';

/**
 * Server-only chain access for Mantle Sepolia (P1.7).
 *
 * Mirrors the db client: secrets (`MANTLE_TESTNET_RPC_URL`, `OPERATOR_PRIVATE_KEY`)
 * are read exclusively from the validated, server-only {@link ENV} — never from a
 * request or a hardcoded literal — and the clients are process singletons so
 * concurrent requests reuse one transport. The `server-only` import makes it a
 * build error to pull this module (and the key it loads) into a client bundle.
 *
 * Reads use a public client; the operator wallet client is built lazily and only
 * when a write path (P1.8) needs it, so a missing operator key never breaks the
 * read-only demo. viem manages nonce and gas estimation per transaction; under
 * concurrent writes, serialize through a single in-flight operation upstream
 * rather than racing the nonce (documented in docs/erc8004-registry.md).
 */

/** Upper bound on a single RPC round-trip before the transport gives up. */
const RPC_TIMEOUT_MS = 10_000;

let publicClient: PublicClient | undefined;
let walletClient: WalletClient | undefined;
let operatorAccount: Account | undefined;
let attestorWalletClient: WalletClient | undefined;
let attestorAccount: Account | undefined;

/** Resolve the configured RPC URL or fail with a clear, value-free message. */
function requireRpcUrl(): string {
  const url = ENV.MANTLE_TESTNET_RPC_URL;
  if (url === undefined || url.length === 0) {
    throw new Error('MANTLE_TESTNET_RPC_URL is required for Mantle testnet access');
  }
  return url;
}

/** Lazily create and return the shared Mantle Sepolia public (read) client. */
export function getMantlePublicClient(): PublicClient {
  if (publicClient === undefined) {
    publicClient = createPublicClient({
      chain: mantleSepolia,
      transport: http(requireRpcUrl(), { timeout: RPC_TIMEOUT_MS }),
    });
  }
  return publicClient;
}

/**
 * A {@link ReputationReader} bound to the configured registry address + ABI,
 * backed by the shared public client. This is the adapter the read wrapper in
 * `registry.ts` consumes in production; tests substitute their own reader.
 */
export function getReputationReader(): ReputationReader {
  const client = getMantlePublicClient();
  const address = CONFIG.chain.reputation_registry_address as Address;
  return {
    getCode: (at: Address) => client.getCode({ address: at }),
    readContract: (functionName: RegistryReadFn, args: readonly unknown[]) =>
      client.readContract({
        address,
        abi: reputationRegistryAbi,
        functionName,
        args,
      } as Parameters<typeof client.readContract>[0]),
  };
}

/** The operator's public address, derived from the validated key. Server-only. */
export function getOperatorAddress(): Address {
  return operatorAddress(parseOperatorKey(ENV.OPERATOR_PRIVATE_KEY));
}

/** Lazily build the operator account (used only by write paths, P1.8). */
function getOperatorAccount(): Account {
  if (operatorAccount === undefined) {
    operatorAccount = privateKeyToAccount(parseOperatorKey(ENV.OPERATOR_PRIVATE_KEY));
  }
  return operatorAccount;
}

/**
 * Lazily create the operator wallet client for Mantle Sepolia writes (P1.8).
 * Throws a value-free error if the operator key is missing/malformed, so a
 * misconfigured deployment fails closed rather than sending an unsigned write.
 */
export function getMantleWalletClient(): WalletClient {
  if (walletClient === undefined) {
    walletClient = createWalletClient({
      account: getOperatorAccount(),
      chain: mantleSepolia,
      transport: http(requireRpcUrl(), { timeout: RPC_TIMEOUT_MS }),
    });
  }
  return walletClient;
}

/** The attestor's public address, derived from the validated key. Server-only. */
export function getAttestorAddress(): Address {
  return operatorAddress(parseAttestorKey(ENV.ATTESTOR_PRIVATE_KEY));
}

/** Lazily build the attestor account (used only by feedback writes, P1.8). */
function getAttestorAccount(): Account {
  if (attestorAccount === undefined) {
    attestorAccount = privateKeyToAccount(parseAttestorKey(ENV.ATTESTOR_PRIVATE_KEY));
  }
  return attestorAccount;
}

/**
 * Assert the attestor and operator keys resolve to different addresses, failing
 * closed otherwise. The registry rejects feedback authored by an agent's
 * owner/operator (self-feedback), and the operator key owns every registered
 * seed agent, so a shared key would make every `giveFeedback` revert. Catching
 * it here turns a wasted on-chain revert into a clear configuration error.
 */
export function assertDistinctSigners(): void {
  assertDistinctSignerKeys(ENV.OPERATOR_PRIVATE_KEY, ENV.ATTESTOR_PRIVATE_KEY);
}

/**
 * Lazily create the attestor wallet client for feedback writes (P1.8). Throws a
 * value-free error if the attestor key is missing/malformed, so a misconfigured
 * deployment fails closed rather than sending an unauthorized write.
 */
export function getMantleAttestorWalletClient(): WalletClient {
  if (attestorWalletClient === undefined) {
    attestorWalletClient = createWalletClient({
      account: getAttestorAccount(),
      chain: mantleSepolia,
      transport: http(requireRpcUrl(), { timeout: RPC_TIMEOUT_MS }),
    });
  }
  return attestorWalletClient;
}

/** True when an error is a contract-level revert (vs. a transport failure). */
function isContractRevert(error: unknown): boolean {
  if (error instanceof ContractFunctionExecutionError) {
    return true;
  }
  if (error instanceof BaseError) {
    return error.walk((e) => e instanceof ContractFunctionExecutionError) !== null;
  }
  return false;
}

/**
 * An {@link IdentityReader} bound to the configured Identity Registry. Maps a
 * "token does not exist" contract revert to `null`/`false` (the deterministic
 * existence semantics the identity helpers expect) while letting transport
 * errors propagate as a typed {@link IdentityError}, so a flaky RPC is never
 * mistaken for an unregistered agent.
 */
export function getIdentityReader(): IdentityReader {
  const client = getMantlePublicClient();
  const address = CONFIG.chain.identity_registry_address as Address;
  return {
    ownerOf: async (agentId) => {
      try {
        const owner = (await client.readContract({
          address,
          abi: identityRegistryAbi,
          functionName: 'ownerOf',
          args: [agentId],
        })) as string;
        return getAddress(owner);
      } catch (error) {
        if (isContractRevert(error)) {
          return null;
        }
        throw new IdentityError('identity ownerOf read failed');
      }
    },
    isAuthorizedOrOwner: async (spender, agentId) => {
      try {
        return (await client.readContract({
          address,
          abi: identityRegistryAbi,
          functionName: 'isAuthorizedOrOwner',
          args: [spender, agentId],
        })) as boolean;
      } catch (error) {
        if (isContractRevert(error)) {
          return false;
        }
        throw new IdentityError('identity isAuthorizedOrOwner read failed');
      }
    },
  };
}

/**
 * An {@link IdentityWriteClient} backed by the **operator (owner)** wallet —
 * `register` makes `msg.sender` the agent owner, so registration must use the
 * operator key, never the attestor key. Returns raw tx hash / receipt; decoding
 * the minted tokenId from the `Registered` event happens in `identity.ts`.
 */
export function getIdentityWriteClient(): IdentityWriteClient {
  const wallet = getMantleWalletClient();
  const publicReader = getMantlePublicClient();
  const address = CONFIG.chain.identity_registry_address as Address;
  const account = getOperatorAccount();
  return {
    writeRegister: (agentURI: string): Promise<Hex> =>
      wallet.writeContract({
        address,
        abi: identityRegistryAbi,
        functionName: 'register',
        args: [agentURI],
        account,
        chain: mantleSepolia,
      }),
    waitForReceipt: async (hash: Hex) => {
      const receipt = await publicReader.waitForTransactionReceipt({ hash });
      return { status: receipt.status, logs: receipt.logs };
    },
  };
}

/**
 * Drop the cached clients so the next getter rebuilds them. Test-only: the
 * singletons would otherwise leak a primed/mocked transport into later tests in
 * the same process. Not for production request paths.
 */
export function resetChainClients(): void {
  publicClient = undefined;
  walletClient = undefined;
  operatorAccount = undefined;
  attestorWalletClient = undefined;
  attestorAccount = undefined;
}
