import type { Address, Hex } from 'viem';

import { parseOnchainAgentId } from '@/lib/chain/agent-id';
import { INT128_MAX, INT128_MIN } from '@/lib/attestation/encode';
import { assertCanAttest, type IdentityReader } from '@/lib/chain/identity';
import { getAttestationById, recordAttestationSubmission } from '@/lib/db/repos/attestations';
import type { AttestationRow } from '@/lib/db/schema';
import type { Queryable } from '@/lib/db/types';

/**
 * Submit one optimistic attestation on-chain (P1.8, task 3): write **exactly
 * one** ERC-8004 `giveFeedback` per `(agent, round)` and record its tx hash.
 *
 * This runs *after* the round's settle transaction has committed the optimistic
 * mirror, never inside it — so a slow or failing chain can never stall the demo
 * arc (the optimistic score is already on screen; this only reconciles it).
 *
 * The chain client is injected behind a narrow {@link FeedbackWriteClient}
 * (mirroring `registry.ts`/`identity.ts`), so every outcome — not registered,
 * self-feedback, RPC failure, race — is unit-testable without a network. Two
 * idempotency layers keep "exactly one write" true under replays and races:
 *   1. the optimistic row already exists (UNIQUE `(agent_id, round_id)`);
 *   2. {@link recordAttestationSubmission} claims it with a `tx_hash IS NULL`
 *      guard, so only the first submit's transaction is ever recorded.
 * A replay finds `tx_hash` already set and short-circuits before sending.
 */

/** The on-chain `giveFeedback` arguments, fully encoded. */
export interface FeedbackWriteArgs {
  readonly agentId: bigint;
  readonly value: bigint;
  readonly valueDecimals: number;
  readonly tag1: string;
  readonly tag2: string;
  /** ERC-8004 service `endpoint` string (Vector uses `''`). */
  readonly endpoint: string;
  readonly feedbackURI: string;
  readonly feedbackHash: Hex;
}

/** Write capability for feedback. Backed by the **attestor** wallet (msg.sender). */
export interface FeedbackWriteClient {
  /** Send `giveFeedback(...)`; resolves to the transaction hash. */
  giveFeedback(args: FeedbackWriteArgs): Promise<Hex>;
}

/** Thrown on an invalid submit precondition (missing row, malformed payload). */
export class AttestationSubmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttestationSubmitError';
  }
}

/** Dependencies for {@link submitAttestation} — the DI seam. */
export interface SubmitDeps {
  readonly db: Queryable;
  readonly writer: FeedbackWriteClient;
  readonly reader: IdentityReader;
  /** The attestor's address (must differ from the agent owner — self-feedback guard). */
  readonly attestor: Address;
  /** Absolute base URL the off-chain detail is served from, e.g. `https://vector.app`. */
  readonly baseUrl: string;
  /** Optional ERC-8004 `endpoint` string; defaults to `''`. */
  readonly endpoint?: string;
}

/** Per-attestation parameters for {@link submitAttestation}. */
export interface SubmitParams {
  /** `attestations.id` of the optimistic mirror to submit. */
  readonly attestationId: string;
  /** The agent's `agents.agent_id_onchain` (decimal `uint256` string, or `null`). */
  readonly agentOnchainId: string | null;
}

/** The disposition of a {@link submitAttestation} call. */
export type SubmitStatus = 'submitted' | 'already_submitted' | 'raced';

/** Result of {@link submitAttestation}. */
export interface SubmitResult {
  readonly status: SubmitStatus;
  readonly attestation: AttestationRow;
  /** The transaction hash — present on `submitted`/`raced`. */
  readonly txHash?: Hex;
}

const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;
const INTEGER_RE = /^-?[0-9]+$/;

/** Construct the absolute off-chain detail URI for an attestation. */
export function buildFeedbackUri(baseUrl: string, attestationId: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new AttestationSubmitError('baseUrl must be an absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AttestationSubmitError('baseUrl must be an http(s) URL');
  }
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/api/attestations/${encodeURIComponent(attestationId)}/feedback`;
}

/**
 * Parse the stored `numeric(39,0)` value into an exact `int128` bigint.
 *
 * The column is wider than `int128`, so a value persisted by any path other than
 * the bounded scorer (or a corrupt/hand-edited row) could exceed the registry's
 * `int128 value` argument. Range-check it *here*, at the chain-write boundary, so
 * an out-of-range value is a deterministic typed error before any gas is spent —
 * rather than a cryptic ABI-encoding throw deep inside the writer.
 */
function toInt128(value: string): bigint {
  if (!INTEGER_RE.test(value)) {
    throw new AttestationSubmitError('attestation value is not an integer');
  }
  const parsed = BigInt(value);
  if (parsed < INT128_MIN || parsed > INT128_MAX) {
    throw new AttestationSubmitError('attestation value is out of int128 range');
  }
  return parsed;
}

/** Assert the stored feedback hash is a well-formed `bytes32` before the write. */
function toFeedbackHash(hash: string | null): Hex {
  if (hash === null || !HEX32_RE.test(hash)) {
    throw new AttestationSubmitError('attestation is missing a valid feedback hash');
  }
  return hash as Hex;
}

/**
 * Submit the optimistic attestation `attestationId` on-chain, returning the
 * disposition. Idempotent: a row that already carries a `tx_hash` returns
 * `already_submitted` without sending a second transaction. Fails closed before
 * any write when the agent is unregistered (`agent_id_onchain` null/malformed)
 * or the attestor is the agent's owner (self-feedback) — turning two guaranteed
 * reverts into deterministic, typed errors rather than wasted gas.
 */
export async function submitAttestation(
  deps: SubmitDeps,
  params: SubmitParams,
): Promise<SubmitResult> {
  const row = await getAttestationById(deps.db, params.attestationId);
  if (row === null) {
    throw new AttestationSubmitError('attestation not found');
  }
  // Already submitted (replay / retry): never send a second transaction.
  if (row.tx_hash !== null) {
    return { status: 'already_submitted', attestation: row };
  }

  // Fail closed *before* the write: a missing token or self-feedback both revert
  // on-chain. `parseOnchainAgentId` rejects an unregistered agent; `assertCanAttest`
  // rejects a nonexistent token or the owner/operator acting as attestor.
  const agentId = parseOnchainAgentId(params.agentOnchainId);
  await assertCanAttest(deps.reader, deps.attestor, agentId);

  const feedbackURI = buildFeedbackUri(deps.baseUrl, row.id);
  const txHash = await deps.writer.giveFeedback({
    agentId,
    value: toInt128(row.value),
    valueDecimals: row.value_decimals,
    tag1: row.tag1 ?? '',
    tag2: row.tag2 ?? '',
    endpoint: deps.endpoint ?? '',
    feedbackURI,
    feedbackHash: toFeedbackHash(row.feedback_hash),
  });

  const claimed = await recordAttestationSubmission(deps.db, {
    id: row.id,
    feedbackUri: feedbackURI,
    txHash,
  });
  if (claimed === null) {
    // Lost the `tx_hash IS NULL` race to a concurrent submit. The other call's
    // transaction is the recorded one; surface this so the caller can see the
    // (in-process coalescing should prevent it) duplicate send.
    return { status: 'raced', attestation: row, txHash };
  }
  return { status: 'submitted', attestation: claimed, txHash };
}
