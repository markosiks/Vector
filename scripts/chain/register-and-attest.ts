/**
 * Register a seed agent in the canonical ERC-8004 Identity Registry and write
 * one `giveFeedback` attestation for it on the Reputation Registry — the live
 * on-chain proof that closes Vector's "primitives implemented but never called"
 * gap (the demo `onScored` hook is a no-op; nothing else drives a real write).
 *
 * This is a thin, idempotent-friendly composition of the already-tested chain
 * layer — it invents no new chain logic:
 *   1. `registerAgent` (operator wallet, msg.sender becomes owner) → mints a
 *      fresh ERC-721 tokenId, decoded from the `Registered` event. That tokenId
 *      is the `agentId` every feedback write is keyed by.
 *   2. `assertCanAttest` (read pre-check) → the attestor must NOT own the agent,
 *      or the canonical registry reverts "Self-feedback not allowed".
 *   3. `giveFeedback` (attestor wallet) → writes the AgentScore on-chain with a
 *      `feedbackHash` anchoring an off-chain detail document (built with the
 *      project's canonical JSON + keccak256, never a bespoke hash).
 *
 * It performs NO database I/O: `DATABASE_URL` only needs to satisfy the env
 * schema's format check (the chain clients never open a pool). For the full
 * DB-backed pipeline see `scripts/sweep-attestations.ts`.
 *
 * Usage (keys + RPC come from the validated server-only env):
 *
 *   DATABASE_URL='postgresql://placeholder/db' \
 *   MANTLE_TESTNET_RPC_URL='https://rpc.sepolia.mantle.xyz' \
 *   PUBLIC_BASE_URL='https://vector.example' \
 *   OPERATOR_PRIVATE_KEY=0x... ATTESTOR_PRIVATE_KEY=0x... \
 *   bun run scripts/chain/register-and-attest.ts
 *
 * Prints the minted agentId and both transaction hashes (with explorer links)
 * so they can go straight into the README / DoraHacks submission.
 */
import { keccak256, toBytes, type Address, type Hex } from 'viem';

import { CONFIG } from '@/lib/config/constants';
import { ENV } from '@/lib/config/env';
import { canonicalJson } from '@/lib/attestation/build';
import { assertCanAttest, registerAgent } from '@/lib/chain/identity';
import {
  getAttestorAddress,
  getFeedbackWriteClient,
  getIdentityReader,
  getIdentityWriteClient,
  getOperatorAddress,
  getReceiptReader,
} from '@/lib/chain/client';

/**
 * Wait until a freshly minted agent is visible to the read RPC. `register` and
 * the subsequent `giveFeedback`/pre-check reads can hit different load-balanced
 * nodes, so the just-minted tokenId may briefly read back as nonexistent
 * (mapped to `null`). Poll `ownerOf` until it resolves rather than failing the
 * run on benign read-after-write lag.
 */
async function waitForAgentRegistered(agentId: bigint, attempts = 20, delayMs = 3_000): Promise<void> {
  const reader = getIdentityReader();
  for (let i = 0; i < attempts; i += 1) {
    const owner = await reader.ownerOf(agentId);
    if (owner !== null) {
      return;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`agent ${agentId.toString()} not visible to read RPC within ${attempts * delayMs}ms`);
}

/** Poll for a transaction receipt until mined or the budget is exhausted. */
async function waitForReceipt(hash: Hex, attempts = 30, delayMs = 3_000): Promise<'success' | 'reverted'> {
  const reader = getReceiptReader();
  for (let i = 0; i < attempts; i += 1) {
    const receipt = await reader.getReceipt(hash);
    if (receipt !== null) {
      return receipt.status;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`receipt for ${hash} not found within ${attempts * delayMs}ms`);
}

/** Explorer tx link for human-friendly output. */
function txLink(hash: Hex): string {
  return `${CONFIG.chain.mantle_explorer_base_url}/tx/${hash}`;
}

/** Require an env value that is optional in the schema but mandatory here. */
function requireEnv(name: 'MANTLE_TESTNET_RPC_URL' | 'PUBLIC_BASE_URL', value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required to run register-and-attest`);
  }
  return value;
}

async function main(): Promise<void> {
  requireEnv('MANTLE_TESTNET_RPC_URL', ENV.MANTLE_TESTNET_RPC_URL);
  const baseUrl = requireEnv('PUBLIC_BASE_URL', ENV.PUBLIC_BASE_URL);

  const operator = getOperatorAddress();
  const attestor = getAttestorAddress();
  const identityAddress = CONFIG.chain.identity_registry_address as Address;
  const reputationAddress = CONFIG.chain.reputation_registry_address as Address;

  console.log(`[runner] operator (owner)  = ${operator}`);
  console.log(`[runner] attestor (author) = ${attestor}`);
  console.log(`[runner] identity registry   = ${identityAddress}`);
  console.log(`[runner] reputation registry = ${reputationAddress}`);

  const seedId = process.env.SEED_AGENT_ID ?? 'vector-seed-1';

  // 1) Register the seed agent (or reuse an already-minted tokenId to avoid a
  //    redundant mint when re-running). The agent card URI is a public,
  //    fetchable pointer; the contract only stores it.
  let agentId: bigint;
  const reuse = process.env.REUSE_AGENT_ID;
  if (reuse !== undefined && reuse.length > 0) {
    agentId = BigInt(reuse);
    console.log(`\n[runner] reusing already-registered agentId(tokenId) = ${agentId.toString()}`);
  } else {
    const agentUri = `${baseUrl}/api/agents/${seedId}/card`;
    console.log(`\n[runner] registering agent "${seedId}" with uri ${agentUri} ...`);
    agentId = await registerAgent(getIdentityWriteClient(), identityAddress, agentUri);
    console.log(`[runner] ✅ registered: agentId(tokenId) = ${agentId.toString()}`);
  }

  // 2) Wait for read-RPC visibility, then run the self-feedback pre-check
  //    against the live registry (fails closed before a wasted reverting write).
  await waitForAgentRegistered(agentId);
  await assertCanAttest(getIdentityReader(), attestor, agentId);

  // 3) Build the off-chain feedback detail + its on-chain integrity hash using
  //    the project's canonical encoder (no bespoke serialization/hash).
  const value = BigInt(process.env.SCORE_VALUE ?? '73500'); // 73.500 at 3 decimals
  const valueDecimals = Number(process.env.SCORE_DECIMALS ?? '3');
  const detail = {
    schema: 'vector.attestation.detail/1',
    agent: { seed_id: seedId, onchain_id: agentId.toString() },
    score: { score_r: '73.500' },
    note: 'Vector AgentScore attestation (register-and-attest runner)',
  };
  const detailJson = canonicalJson(detail);
  const feedbackHash = keccak256(toBytes(detailJson));
  const feedbackUri = `${baseUrl}/api/attestations/${agentId.toString()}/feedback`;

  console.log(`\n[runner] writing giveFeedback for agentId ${agentId.toString()} ...`);
  const feedbackTx = await getFeedbackWriteClient().giveFeedback({
    agentId,
    value,
    valueDecimals,
    tag1: 'vector',
    tag2: 'agentscore',
    endpoint: '',
    feedbackURI: feedbackUri,
    feedbackHash,
  });
  console.log(`[runner] ✅ giveFeedback submitted: ${feedbackTx}`);
  const feedbackStatus = await waitForReceipt(feedbackTx);
  if (feedbackStatus !== 'success') {
    throw new Error(`giveFeedback reverted (tx ${feedbackTx})`);
  }
  console.log(`[runner] ✅ giveFeedback mined: status=${feedbackStatus}`);

  console.log(`\n[runner] DONE — live on-chain footprint on Mantle Sepolia:`);
  console.log(`  agentId (tokenId): ${agentId.toString()}`);
  console.log(`  identity registry: ${CONFIG.chain.mantle_explorer_base_url}/address/${identityAddress}`);
  console.log(`  feedback tx:       ${txLink(feedbackTx)}`);
  console.log(`  feedbackHash:      ${feedbackHash}`);
}

main().catch((err) => {
  console.error('[runner] failed:', err);
  process.exit(1);
});
