import { describe, expect, test, beforeAll } from 'bun:test';
import { createPublicClient, http, type PublicClient, type Transport, type Chain } from 'viem';

import { mantleSepolia } from '@/lib/chain/mantle-sepolia';
import {
  smokeRead,
  getIdentityRegistry,
  getSummary,
  REGISTRY_ADDRESS,
} from '@/lib/chain/reputation-read';
import { TESTNET_IDENTITY_REGISTRY, TESTNET_REPUTATION_REGISTRY } from '@/lib/chain/addresses';
import { CONFIG } from '@/lib/config/constants';

/**
 * Integration tests against the live Mantle Sepolia testnet.
 *
 * These tests hit the real canonical ERC-8004 Reputation Registry. They are
 * skipped when `MANTLE_TESTNET_RPC_URL` is not set (CI without testnet access).
 *
 * To run locally:
 *   MANTLE_TESTNET_RPC_URL=https://rpc.sepolia.mantle.xyz bun test tests/integration/chain.registry
 */

const RPC_URL = process.env.MANTLE_TESTNET_RPC_URL;
const SKIP = !RPC_URL;

let client: PublicClient<Transport, Chain>;

beforeAll(() => {
  if (SKIP) return;
  client = createPublicClient({
    chain: mantleSepolia,
    transport: http(RPC_URL!, { timeout: 30_000, retryCount: 2 }),
  });
});

describe.skipIf(SKIP)('Live Mantle Sepolia — Reputation Registry', () => {
  test(
    'smokeRead returns ok:true',
    async () => {
      const result = await smokeRead(client);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.registryAddress).toBe(TESTNET_REPUTATION_REGISTRY);
      }
    },
    { timeout: 30_000 },
  );

  test(
    'getIdentityRegistry returns the canonical Identity Registry address',
    async () => {
      const addr = await getIdentityRegistry(client);
      expect(addr.toLowerCase()).toBe(TESTNET_IDENTITY_REGISTRY.toLowerCase());
    },
    { timeout: 30_000 },
  );

  test(
    'getSummary for agentId=0 returns zero feedback (no agent 0)',
    async () => {
      const summary = await getSummary(client, 0n);
      expect(summary.count).toBe(0n);
    },
    { timeout: 30_000 },
  );

  test(
    'getSummary for a very large agentId returns zero feedback',
    async () => {
      const hugeId = 2n ** 200n;
      const summary = await getSummary(client, hugeId);
      expect(summary.count).toBe(0n);
    },
    { timeout: 30_000 },
  );

  test(
    'CONFIG.erc8004 addresses match the live registry',
    async () => {
      const identityAddr = await getIdentityRegistry(client);
      expect(identityAddr.toLowerCase()).toBe(
        CONFIG.erc8004.identity_registry.toLowerCase(),
      );
    },
    { timeout: 30_000 },
  );
});

describe.skipIf(SKIP)('Live Mantle Sepolia — chain sanity', () => {
  test(
    'client chain id is 5003',
    async () => {
      const chainId = await client.getChainId();
      expect(chainId).toBe(5003);
    },
    { timeout: 15_000 },
  );

  test(
    'latest block number is above the deploy block',
    async () => {
      const block = await client.getBlockNumber();
      expect(block).toBeGreaterThan(34_586_937n);
    },
    { timeout: 15_000 },
  );
});
