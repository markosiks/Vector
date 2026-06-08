import { describe, expect, mock, test } from 'bun:test';

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
// chain read path never touches Postgres. Supply a placeholder so importing the
// chain client doesn't fail env validation.
process.env.DATABASE_URL ??= 'postgres://placeholder:5432/vector_test';

mock.module('server-only', () => ({}));

describeChain('P1.7 DoD — registry readable from the app', () => {
  test('production read path resolves the registry, identity, version and an agent client list', async () => {
    const { getReputationReader } = await import('@/lib/chain/client');
    const { smokeRead, getClients } = await import('@/lib/chain/registry');
    const { onchainAgentId } = await import('@/lib/chain/agent-id');
    const { SEED_LEADER_ID } = await import('@/lib/agents/seed');

    const reader = getReputationReader();
    const address = CONFIG.chain.reputation_registry_address as `0x${string}`;

    const smoke = await smokeRead(reader, address);
    expect(smoke.deployed).toBe(true);
    expect(smoke.identityRegistry.toLowerCase()).toBe(
      CONFIG.chain.identity_registry_address.toLowerCase(),
    );

    // `getClients` for an operator-assigned agentId must succeed structurally
    // even with no feedback yet (empty list), proving the read path end to end.
    // (Unlike `getSummary`, it has no non-empty-clients precondition.)
    const agentId = onchainAgentId(SEED_LEADER_ID)!;
    const clients = await getClients(reader, agentId);
    expect(Array.isArray(clients)).toBe(true);
  });
});
