import { listIntentHashesByAgentRound } from '@/lib/db/repos/intents';
import {
  getAttestationByAgentRound,
  insertAttestationOptimistic,
} from '@/lib/db/repos/attestations';
import type { AttestationRow, OutcomeRow, PolicyEventRow } from '@/lib/db/schema';
import type { Queryable } from '@/lib/db/types';
import type { ScoreInputs, ScoreResult } from '@/lib/scoring/types';

import { buildAttestationDetail } from './build';
import { deriveOutcomeClass, encodeFeedback } from './encode';
import { reconcile, type ReconcileDeps, type ReconcileResult } from './reconcile';
import { submitAttestation, type SubmitDeps, type SubmitResult } from './submit';

/**
 * The attestation pipeline's two halves, wired to the demo spine (P1.8):
 *
 *  - {@link mirrorAttestation} — runs **inside** the round's settle transaction,
 *    right after the score is persisted. It encodes the payload, builds the
 *    off-chain detail + hash, and writes the optimistic mirror row atomically
 *    with the score, so the UI shows an optimistic-anchored score immediately.
 *  - {@link submitAndReconcile} — runs **after** that transaction commits, off
 *    the demo's critical path: it sends the single `giveFeedback` and watches the
 *    receipt to flip `optimistic → confirmed/failed`. A slow/failing chain only
 *    delays reconciliation; it never blocks the arc.
 *
 * Splitting the two is what makes "latency never breaks the arc" structural
 * rather than aspirational: the on-chain write is simply not in the settle
 * transaction's path.
 */

/** The settle-time facts {@link mirrorAttestation} needs (all already in scope at settle). */
export interface MirrorFacts {
  readonly agent: {
    readonly seedId: string;
    readonly uuid: string;
    /** `agents.agent_id_onchain`, or `null` when not yet registered. */
    readonly onchainId: string | null;
  };
  readonly roundId: string;
  readonly result: ScoreResult;
  readonly inputs: ScoreInputs;
  readonly outcomes: readonly OutcomeRow[];
  readonly policyEvents: readonly PolicyEventRow[];
}

/** Result of {@link mirrorAttestation}. */
export interface MirrorResult {
  readonly attestation: AttestationRow;
  /** `false` when an attestation for this `(agent, round)` already existed (idempotent). */
  readonly created: boolean;
}

/**
 * Mirror one scored round into an optimistic attestation row, idempotently.
 * Encodes `value`/`valueDecimals`/`tag1`/`tag2`, builds the canonical detail
 * document + `feedbackHash`, and inserts the row `ON CONFLICT DO NOTHING`. A
 * replay (double settle, retry) finds the existing row and returns it with
 * `created: false` — never a second mirror. Must be called with the settle
 * transaction's `db` so the mirror is atomic with the score it anchors.
 */
export async function mirrorAttestation(db: Queryable, facts: MirrorFacts): Promise<MirrorResult> {
  const outcomeClass = deriveOutcomeClass({
    soft: facts.inputs.soft,
    hard: facts.inputs.hard,
    halt: facts.inputs.halt,
    crashed: facts.result.crashed,
  });
  const feedback = encodeFeedback({
    scoreR: facts.result.score_r,
    roundId: facts.roundId,
    outcomeClass,
  });

  const intentHashes = await listIntentHashesByAgentRound(db, facts.agent.uuid, facts.roundId);
  const detail = buildAttestationDetail({
    agent: facts.agent,
    roundId: facts.roundId,
    score: {
      scoreR: facts.result.score_r,
      rawR: facts.result.raw_r,
      components: facts.result.components,
    },
    outcomeClass,
    aggregates: {
      pnl_r: facts.inputs.pnl_r,
      car_r: facts.inputs.car_r,
      dd_r: facts.inputs.dd_r,
      soft: facts.inputs.soft,
      hard: facts.inputs.hard,
      halt: facts.inputs.halt,
      drain: facts.inputs.drain_r,
    },
    outcomes: facts.outcomes,
    policyEvents: facts.policyEvents,
    intentHashes,
    feedback,
  });

  const inserted = await insertAttestationOptimistic(db, {
    agent_id: facts.agent.uuid,
    round_id: facts.roundId,
    value: feedback.value.toString(),
    value_decimals: feedback.valueDecimals,
    tag1: feedback.tag1,
    tag2: feedback.tag2,
    feedback_hash: detail.hash,
    feedback_detail: detail.json,
    chain_state: 'optimistic',
  });
  if (inserted !== null) {
    return { attestation: inserted, created: true };
  }

  // Conflict: an attestation already exists for this (agent, round). Re-read it.
  const existing = await getAttestationByAgentRound(db, facts.agent.uuid, facts.roundId);
  if (existing === null) {
    throw new Error(
      `mirrorAttestation: row vanished for agent ${facts.agent.uuid} round ${facts.roundId}`,
    );
  }
  return { attestation: existing, created: false };
}

/** Result of {@link submitAndReconcile}. */
export interface SubmitAndReconcileResult {
  readonly submit: SubmitResult;
  /** `undefined` when submission was a no-op (already submitted with no new tx). */
  readonly reconcile?: ReconcileResult;
}

/**
 * Run the post-commit half for one attestation: submit the single `giveFeedback`
 * then watch its receipt. Idempotent end to end — a replay short-circuits in
 * {@link submitAttestation} and still reconciles the already-submitted tx. The
 * two dependency bundles are the DI seams the live adapter binds to real viem
 * clients and tests bind to fakes.
 */
export async function submitAndReconcile(
  submitDeps: SubmitDeps,
  reconcileDeps: Omit<ReconcileDeps, 'db'>,
  params: { readonly attestationId: string; readonly agentOnchainId: string | null },
): Promise<SubmitAndReconcileResult> {
  const submit = await submitAttestation(submitDeps, {
    attestationId: params.attestationId,
    agentOnchainId: params.agentOnchainId,
  });
  const reconcileResult = await reconcile(
    { db: submitDeps.db, ...reconcileDeps },
    params.attestationId,
  );
  return { submit, reconcile: reconcileResult };
}
