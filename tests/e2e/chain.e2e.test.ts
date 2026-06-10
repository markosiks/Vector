import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';

/**
 * Hard end-to-end check of the P1.7 Definition of Done: a working, readable
 * Reputation Registry on Mantle testnet, reachable from the app exactly as
 * production wires it (config address → server-only client adapter → read
 * wrapper). Gated on `MANTLE_TESTNET_RPC_URL`, like the integration suite.
 */
const RPC = process.env.MANTLE_TESTNET_RPC_URL;
const hasRpc = typeof RPC === 'string' && RPC.length > 0;
const describeChain = hasRpc ? describe : describe.skip;

// `ENV` is a single eager global that requires DATABASE_URL even though the
// chain read path never touches Postgres. The gated test below supplies a
// placeholder so importing the chain client doesn't fail env validation.
//
// This MUST NOT be a bare top-level assignment. Under `bun test` every file in
// the run shares one process and Bun evaluates all files' top-level code in a
// single collection pass *before* any test or hook runs. A top-level write here
// would still be set when later files are collected, flipping peers that gate
// on `DATABASE_URL` at import — e.g. `tests/e2e/data-model.e2e.test.ts`'s
// `hasDb` const, which selects `describe` vs `describe.skip` for the real-Neon
// migration suite. Those tests would then try to connect to a placeholder
// Postgres and fail instead of skipping without a real DB. Confining the write
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

describeChain('P1.7 DoD — registry readable from the app', () => {
  test('production read path resolves the registry, identity, version and an agent client list', async () => {
    const { getReputationReader } = await import('@/lib/chain/client');
    const { smokeRead, getClients } = await import('@/lib/chain/registry');

    const reader = getReputationReader();
    const address = CONFIG.chain.reputation_registry_address as `0x${string}`;

    const smoke = await smokeRead(reader, address);
    expect(smoke.deployed).toBe(true);
    expect(smoke.identityRegistry.toLowerCase()).toBe(
      CONFIG.chain.identity_registry_address.toLowerCase(),
    );

    // `getClients` must succeed structurally, proving the read path end to end.
    // A fixed canonical tokenId (1) is used purely as a liveness probe — it is a
    // pre-existing registered agent on the shared testnet registry, NOT one of
    // Vector's (whose ids are null until P1.8 registration). Vector never writes
    // against it; this only exercises the read wrapper against a real agentId.
    const clients = await getClients(reader, 1n);
    expect(Array.isArray(clients)).toBe(true);
  });
});
