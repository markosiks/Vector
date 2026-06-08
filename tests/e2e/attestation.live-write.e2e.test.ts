import { afterAll, describe, expect, mock, test } from 'bun:test';
import { keccak256, toBytes } from 'viem';

import { CONFIG } from '@/lib/config/constants';

/**
 * Live ERC-8004 **write** path against the real Mantle Sepolia registries
 * (P1.8 task 3). The rest of the suite injects a fake `giveFeedback`/receipt
 * client because a funded testnet wallet is out of band; this test closes that
 * gap by driving the *production* clients — `getIdentityWriteClient`,
 * `getFeedbackWriteClient`, `getReputationReader` — end to end:
 *
 *   register a fresh agent (operator key) → assertCanAttest against the live
 *   Identity Registry → giveFeedback (attestor key) → wait for the receipt →
 *   read the feedback back off-chain and confirm the on-chain bytes match.
 *
 * It is gated on a funded operator + a *distinct* funded attestor key, so CI
 * without testnet funds stays green. To run (both wallets need a little test
 * MNT from https://faucet.sepolia.mantle.xyz):
 *
 *   MANTLE_TESTNET_RPC_URL='https://rpc.sepolia.mantle.xyz' \
 *   OPERATOR_PRIVATE_KEY=0x... ATTESTOR_PRIVATE_KEY=0x... \
 *   bun test tests/e2e/attestation.live-write.e2e.test.ts
 *
 * `server-only` is neutralized because the test imports the chain client
 * directly, outside the Next runtime.
 */
const RPC = process.env.MANTLE_TESTNET_RPC_URL;
const OPERATOR = process.env.OPERATOR_PRIVATE_KEY;
const ATTESTOR = process.env.ATTESTOR_PRIVATE_KEY;
const hasLiveWrite =
  typeof RPC === 'string' &&
  RPC.length > 0 &&
  typeof OPERATOR === 'string' &&
  OPERATOR.length > 0 &&
  typeof ATTESTOR === 'string' &&
  ATTESTOR.length > 0 &&
  OPERATOR !== ATTESTOR;
const describeLive = hasLiveWrite ? describe : describe.skip;

/**
 * Poll an async predicate until it returns a non-null/true value, or throw after
 * `attempts`. The public Mantle Sepolia RPC load-balances reads across replicas
 * that trail the head by a block or two, so a read issued immediately after a
 * confirmed write can miss it. This barrier makes the test deterministic against
 * that replica lag without masking a genuine "never appears" failure. (Vector's
 * production flow registers agents at seed time, well before any per-round
 * attestation, so it never reads its own write this tightly.)
 */
async function waitFor<T>(
  what: string,
  read: () => Promise<T | null | undefined>,
  { attempts = 15, delayMs = 2_000 }: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  for (let i = 0; i < attempts; i += 1) {
    const value = await read();
    if (value !== null && value !== undefined && value !== false) {
      return value as T;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`timed out waiting for ${what} to become visible on the RPC`);
}

// `ENV` is a single eager global that requires DATABASE_URL even though the
// chain write path never touches Postgres. Supply a syntactically valid
// placeholder so importing the chain client doesn't fail env validation.
process.env.DATABASE_URL ??= 'postgres://placeholder:5432/vector_test';

mock.module('server-only', () => ({}));

describeLive('ERC-8004 feedback write path (live Mantle Sepolia, funded wallets)', () => {
  afterAll(() => {
    mock.restore();
  });

  test(
    'register → giveFeedback → receipt → read-back round-trips against the live registry',
    async () => {
      const {
        getIdentityWriteClient,
        getIdentityReader,
        getReputationReader,
        getFeedbackWriteClient,
        getAttestorAddress,
        getOperatorAddress,
        getMantlePublicClient,
        assertDistinctSigners,
      } = await import('@/lib/chain/client');
      const { registerAgent, assertCanAttest } = await import('@/lib/chain/identity');
      const { getLastIndex, readFeedback } = await import('@/lib/chain/registry');

      // The self-feedback guard is a configuration invariant: the operator owns
      // every registered agent, so the attestor key MUST resolve elsewhere.
      assertDistinctSigners();
      expect(getOperatorAddress()).not.toBe(getAttestorAddress());

      const identityAddress = CONFIG.chain.identity_registry_address as `0x${string}`;

      // 1) Register a fresh agent with the operator wallet — a real mint whose
      //    tokenId is decoded from the `Registered` event in the receipt.
      const agentURI = `https://vector.app/agents/live-${Date.now()}`;
      const agentId = await registerAgent(getIdentityWriteClient(), identityAddress, agentURI);
      expect(agentId).toBeGreaterThan(0n);

      // Read-after-write barrier: wait until the just-minted token is visible on
      // whichever replica serves our reads before exercising the read path.
      const identityReader = getIdentityReader();
      const owner = await waitFor('agent registration', () => identityReader.ownerOf(agentId));
      expect(owner.toLowerCase()).toBe(getOperatorAddress().toLowerCase());

      // 2) The production authorization pre-check, against the live registry:
      //    registered (owner !== null) and not self-feedback (attestor is not
      //    owner/operator). A throw here would mean the write would revert.
      const attestor = getAttestorAddress();
      await assertCanAttest(identityReader, attestor, agentId);

      // 3) Issue exactly one real `giveFeedback` with the attestor wallet.
      const feedbackHash = keccak256(toBytes(`live-detail-${agentId}`));
      const txHash = await getFeedbackWriteClient().giveFeedback({
        agentId,
        value: 73n,
        valueDecimals: 0,
        tag1: 'r-live-1',
        tag2: 'clean',
        endpoint: '',
        feedbackURI: `https://vector.app/feedback/${agentId}/r-live-1`,
        feedbackHash,
      });
      expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

      // 4) The write must actually commit, not just broadcast.
      const receipt = await getMantlePublicClient().waitForTransactionReceipt({ hash: txHash });
      expect(receipt.status).toBe('success');

      // 5) Read the feedback back off-chain and confirm the on-chain record
      //    carries the exact values we wrote — the full write→read round-trip.
      const reader = getReputationReader();
      const lastIndex = await waitFor('feedback to be indexed', async () => {
        const index = await getLastIndex(reader, agentId, attestor);
        return index >= 1n ? index : null;
      });
      const feedback = await readFeedback(reader, agentId, attestor, lastIndex);
      expect(feedback.value).toBe(73n);
      expect(feedback.valueDecimals).toBe(0);
      expect(feedback.tag1).toBe('r-live-1');
      expect(feedback.tag2).toBe('clean');
      expect(feedback.isRevoked).toBe(false);
    },
    120_000,
  );
});
