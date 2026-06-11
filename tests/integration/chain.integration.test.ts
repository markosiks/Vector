import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';

/**
 * Integration tests against the **real** canonical ERC-8004 Reputation Registry
 * on Mantle Sepolia. Skipped unless `MANTLE_TESTNET_RPC_URL` is set, so CI
 * without chain access stays green. To run:
 *
 *   MANTLE_TESTNET_RPC_URL='https://rpc.sepolia.mantle.xyz' bun test tests/integration
 *
 * `server-only` is neutralized because these tests import the chain client
 * directly, outside the Next runtime.
 */
const RPC = process.env.MANTLE_TESTNET_RPC_URL;
const hasRpc = typeof RPC === 'string' && RPC.length > 0;
const describeChain = hasRpc ? describe : describe.skip;

// `ENV` is a single eager global that requires DATABASE_URL even though the
// chain read path never touches Postgres. The gated tests below supply a
// syntactically valid placeholder so importing the chain client doesn't fail
// env validation.
//
// This MUST NOT be a bare top-level assignment. Under `bun test` every file in
// the run shares one process and Bun evaluates all files' top-level code in a
// single collection pass *before* any hook runs. A top-level write here would
// still be set when later files are collected, flipping peers that gate on
// `DATABASE_URL` at import — e.g. the `hasDb` consts in
// `tests/integration/credibility.integration.test.ts` and the other real-Neon
// suites, which select `describe` vs `describe.skip`. Those tests would then
// connect to a placeholder Postgres and fail instead of skipping without a
// real DB (same leak PR #44 fixed for e2e; guarded by
// `tests/integration/env-isolation.integration.test.ts`). Confining the write
// to `beforeAll`/`afterAll` (execution phase) keeps the collection-time env
// clean for every other file.
let prevDbUrl: string | undefined;

beforeAll(() => {
  prevDbUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL ??= 'postgres://placeholder:5432/vector_test';
});

afterAll(() => {
  if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDbUrl;
});

mock.module('server-only', () => ({}));

describeChain('Mantle Sepolia ERC-8004 Reputation Registry (real RPC)', () => {
  test('public client reports chain id 5003', async () => {
    const { getMantlePublicClient } = await import('@/lib/chain/client');
    expect(await getMantlePublicClient().getChainId()).toBe(CONFIG.chain.mantle_testnet_chain_id);
  });

  test('smoke-read proves the registry is live and wired to the config Identity Registry', async () => {
    const { getReputationReader } = await import('@/lib/chain/client');
    const { smokeRead } = await import('@/lib/chain/registry');
    const result = await smokeRead(
      getReputationReader(),
      CONFIG.chain.reputation_registry_address as `0x${string}`,
    );
    expect(result.deployed).toBe(true);
    expect(result.identityRegistry.toLowerCase()).toBe(
      CONFIG.chain.identity_registry_address.toLowerCase(),
    );
    expect(result.version.length).toBeGreaterThan(0);
  });

  test('a tiny RPC timeout fails as a typed error rather than hanging', async () => {
    const { createPublicClient, http } = await import('viem');
    const { mantleSepolia } = await import('@/lib/chain/network');
    const { getIdentityRegistry } = await import('@/lib/chain/registry');
    const { reputationRegistryAbi } = await import('@/lib/chain/abi');
    const slow = createPublicClient({
      chain: mantleSepolia,
      transport: http(RPC, { timeout: 1, retryCount: 0 }),
    });
    const reader = {
      getCode: (address: `0x${string}`) => slow.getCode({ address }),
      readContract: (functionName: never, args: readonly unknown[]) =>
        slow.readContract({
          address: CONFIG.chain.reputation_registry_address as `0x${string}`,
          abi: reputationRegistryAbi,
          functionName,
          args,
        } as Parameters<typeof slow.readContract>[0]),
    };
    await expect(getIdentityRegistry(reader)).rejects.toBeDefined();
  });

  // Verifies the hand-authored `identityRegistryAbi` against the LIVE v2
  // contract (the published abis/IdentityRegistry.json is stale and lacks
  // isAuthorizedOrOwner), and proves the identity reader's existence semantics.
  test('identity reader: a canonical registered agent exists; a huge id does not', async () => {
    const { getIdentityReader } = await import('@/lib/chain/client');
    const { agentExists } = await import('@/lib/chain/identity');
    const reader = getIdentityReader();

    // tokenId 1 is a pre-existing registered agent on the shared testnet registry.
    expect(await agentExists(reader, 1n)).toBe(true);
    const owner = await reader.ownerOf(1n);
    expect(owner).not.toBeNull();
    // The owner is, by definition, authorized over its own agent.
    expect(await reader.isAuthorizedOrOwner(owner as `0x${string}`, 1n)).toBe(true);
    // A random address is not.
    expect(await reader.isAuthorizedOrOwner('0x1111111111111111111111111111111111111111', 1n)).toBe(
      false,
    );
    // An almost-certainly-unminted id reads back as "does not exist", not a throw.
    expect(await agentExists(reader, (1n << 200n) + 12345n)).toBe(false);
  });

  test('assertCanAttest blocks self-feedback and unregistered agents against the live registry', async () => {
    const { getIdentityReader } = await import('@/lib/chain/client');
    const { assertCanAttest } = await import('@/lib/chain/identity');
    const reader = getIdentityReader();
    const owner = (await reader.ownerOf(1n)) as `0x${string}`;

    // Owner attesting its own agent → rejected (mirrors the on-chain guard).
    await expect(assertCanAttest(reader, owner, 1n)).rejects.toThrow(/self-feedback/i);
    // A distinct attestor over a registered agent → allowed.
    await expect(
      assertCanAttest(reader, '0x1111111111111111111111111111111111111111', 1n),
    ).resolves.toBeUndefined();
    // Unregistered agent → rejected before any write.
    await expect(
      assertCanAttest(reader, '0x1111111111111111111111111111111111111111', (1n << 200n) + 7n),
    ).rejects.toThrow(/not registered/);
  });

  afterAll(async () => {
    const { resetChainClients } = await import('@/lib/chain/client');
    resetChainClients();
  });
});
