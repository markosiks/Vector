import 'server-only';

import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Transport,
  type Chain,
  type Account,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ENV } from '@/lib/config/env';
import { CONFIG } from '@/lib/config/constants';
import { mantleSepolia } from './mantle-sepolia';

/**
 * Lazily-initialized viem clients for Mantle Sepolia testnet.
 *
 * The public client (read-only) is available whenever `MANTLE_TESTNET_RPC_URL`
 * is set. The wallet client (write) additionally requires `OPERATOR_PRIVATE_KEY`.
 *
 * Both are singletons — created on first access, reused thereafter. The
 * `server-only` import guarantees these never enter a client bundle.
 *
 * ## Chain-id validation
 *
 * The public client's chain is bound to `mantleSepolia` (id 5003), which must
 * match `CONFIG.chain.mantle_testnet_chain_id`. A mismatch at module load is a
 * fatal misconfiguration (wrong network); throw immediately.
 */

if (mantleSepolia.id !== CONFIG.chain.mantle_testnet_chain_id) {
  throw new Error(
    `Chain-id mismatch: viem chain definition has ${mantleSepolia.id}, ` +
      `but CONFIG.chain.mantle_testnet_chain_id is ${CONFIG.chain.mantle_testnet_chain_id}. ` +
      `Fix the chain definition or the seeded config.`,
  );
}

// ── Lazy singletons ─────────────────────────────────────────────────────

let _publicClient: PublicClient<Transport, Chain> | undefined;
let _walletClient: WalletClient<Transport, Chain, Account> | undefined;

/**
 * Returns a read-only viem public client connected to Mantle Sepolia.
 *
 * @throws if `MANTLE_TESTNET_RPC_URL` is not set.
 */
export function getPublicClient(): PublicClient<Transport, Chain> {
  if (_publicClient) return _publicClient;

  const rpcUrl = ENV.MANTLE_TESTNET_RPC_URL;
  if (!rpcUrl) {
    throw new Error(
      'MANTLE_TESTNET_RPC_URL is not set. Cannot create a public client for Mantle Sepolia.',
    );
  }

  _publicClient = createPublicClient({
    chain: mantleSepolia,
    transport: http(rpcUrl, {
      // Conservative timeout for testnet RPCs that may be slow.
      timeout: 30_000,
      retryCount: 2,
      retryDelay: 1_000,
    }),
  });
  return _publicClient;
}

/**
 * Returns a write-capable viem wallet client for the operator account.
 *
 * The operator private key is read from `OPERATOR_PRIVATE_KEY` (server-only,
 * never logged). The derived address is the `from` for all on-chain writes
 * (ERC-8004 `giveFeedback` calls in P1.8).
 *
 * @throws if `MANTLE_TESTNET_RPC_URL` or `OPERATOR_PRIVATE_KEY` is not set.
 */
export function getWalletClient(): WalletClient<Transport, Chain, Account> {
  if (_walletClient) return _walletClient;

  const rpcUrl = ENV.MANTLE_TESTNET_RPC_URL;
  if (!rpcUrl) {
    throw new Error(
      'MANTLE_TESTNET_RPC_URL is not set. Cannot create a wallet client for Mantle Sepolia.',
    );
  }

  const pk = ENV.OPERATOR_PRIVATE_KEY;
  if (!pk) {
    throw new Error(
      'OPERATOR_PRIVATE_KEY is not set. Cannot create a wallet client. ' +
        'The operator key is required for on-chain writes (ERC-8004 attestations).',
    );
  }

  const account = privateKeyToAccount(pk as `0x${string}`);

  _walletClient = createWalletClient({
    account,
    chain: mantleSepolia,
    transport: http(rpcUrl, {
      timeout: 30_000,
      retryCount: 2,
      retryDelay: 1_000,
    }),
  });
  return _walletClient;
}

/**
 * Derive the operator address from `OPERATOR_PRIVATE_KEY` without creating a
 * full wallet client. Useful for logging / config dumps (the address is not
 * secret).
 *
 * @throws if `OPERATOR_PRIVATE_KEY` is not set.
 */
export function getOperatorAddress(): `0x${string}` {
  const pk = ENV.OPERATOR_PRIVATE_KEY;
  if (!pk) {
    throw new Error('OPERATOR_PRIVATE_KEY is not set.');
  }
  return privateKeyToAccount(pk as `0x${string}`).address;
}

/**
 * Reset cached clients. Intended **only** for tests that need to swap
 * transports or keys between runs.
 */
export function _resetClients(): void {
  _publicClient = undefined;
  _walletClient = undefined;
}
