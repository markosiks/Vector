import 'server-only';

import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';

import { CONFIG } from '../config/constants';
import { ENV } from '../config/env';
import { reputationRegistryAbi } from './abi';
import { mantleSepolia } from './network';
import { operatorAddress, parseOperatorKey } from './operator.schema';
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

/**
 * Drop the cached clients so the next getter rebuilds them. Test-only: the
 * singletons would otherwise leak a primed/mocked transport into later tests in
 * the same process. Not for production request paths.
 */
export function resetChainClients(): void {
  publicClient = undefined;
  walletClient = undefined;
  operatorAccount = undefined;
}
