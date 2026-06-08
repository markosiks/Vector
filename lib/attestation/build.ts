import { keccak256, toBytes, type Hex } from 'viem';

import type { OutcomeRow, PolicyEventRow } from '@/lib/db/schema';
import type { ScoreComponents } from '@/lib/scoring/types';

import type { EncodedFeedback, OutcomeClass } from './encode';

/**
 * Build the off-chain feedback **detail** document and its integrity hash (P1.8,
 * task 1). The detail JSON is the human/agent-readable record of one settled
 * round — PnL, capital-at-risk, the round's policy events, and the intent hashes
 * — served off-chain at `feedbackURI`. Its KECCAK-256 (`feedbackHash`) is written
 * *on-chain* alongside the score, so anyone can re-hash the served bytes and
 * prove they are exactly what was attested: integrity without putting the detail
 * on-chain.
 *
 * The document is serialized with a **canonical** JSON encoding (recursively
 * sorted keys, no incidental whitespace) so the *bytes* — and therefore the hash
 * — are reproducible from the same facts. Those exact bytes are what the pipeline
 * stores in `attestations.feedback_detail` and serves verbatim at the endpoint,
 * so the served payload always re-hashes to the stored `feedback_hash` (no
 * build-vs-serve drift). This module is pure: no I/O, no clock, no randomness.
 */

/** Schema tag embedded in every detail document; bump on a breaking shape change. */
export const ATTESTATION_DETAIL_SCHEMA = 'vector.attestation.detail/1';

/** The aggregated round facts mirrored into the detail document (the scorer's inputs). */
export interface AttestationAggregates {
  readonly pnl_r: number;
  readonly car_r: number;
  readonly dd_r: number;
  readonly soft: number;
  readonly hard: number;
  readonly halt: number;
  readonly drain: boolean;
}

/** Everything the builder needs to assemble one round's detail document. */
export interface AttestationDetailFacts {
  readonly agent: {
    readonly seedId: string;
    readonly uuid: string;
    /** `agents.agent_id_onchain`, or `null` when the agent is not yet registered. */
    readonly onchainId: string | null;
  };
  readonly roundId: string;
  readonly score: {
    /** EWMA AgentScore, fixed-scale string (e.g. `"73.500"`). */
    readonly scoreR: string;
    /** Pre-EWMA round score, fixed-scale string. */
    readonly rawR: string;
    readonly components: ScoreComponents;
  };
  readonly outcomeClass: OutcomeClass;
  readonly aggregates: AttestationAggregates;
  readonly outcomes: readonly OutcomeRow[];
  readonly policyEvents: readonly PolicyEventRow[];
  readonly intentHashes: readonly string[];
  readonly feedback: EncodedFeedback;
}

/** The built artifact: the structured document, its canonical bytes, and the hash. */
export interface AttestationDetail {
  /** The structured detail document (for typed consumers/tests). */
  readonly detail: Record<string, unknown>;
  /** The canonical JSON serialization — the exact bytes stored *and* served. */
  readonly json: string;
  /** `KECCAK-256(json)` — the on-chain `feedbackHash` anchoring the bytes above. */
  readonly hash: Hex;
}

/**
 * Serialize `value` to canonical JSON: object keys sorted lexicographically at
 * every depth, arrays in source order, no incidental whitespace. Deterministic
 * for any JSON-serializable input, so the same facts always hash identically.
 *
 * `undefined`, functions and symbols are not part of the document shape; a
 * `bigint` is rejected (it must be stringified by the caller before it reaches
 * the document) so a numeric overflow can never silently change the bytes.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') {
    throw new TypeError('canonicalJson: bigint must be stringified before serialization');
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Assemble one round's off-chain detail document, serialize it canonically, and
 * hash it. The `value` (a Solidity `int128`) is carried as a decimal string so
 * the document stays plain JSON and the bytes never depend on a bigint's
 * serialization.
 */
export function buildAttestationDetail(facts: AttestationDetailFacts): AttestationDetail {
  const detail: Record<string, unknown> = {
    schema: ATTESTATION_DETAIL_SCHEMA,
    agent: {
      seed_id: facts.agent.seedId,
      uuid: facts.agent.uuid,
      onchain_id: facts.agent.onchainId,
    },
    round_id: facts.roundId,
    outcome_class: facts.outcomeClass,
    score: {
      score_r: facts.score.scoreR,
      raw_r: facts.score.rawR,
      components: {
        perf: facts.score.components.perf,
        w: facts.score.components.w,
        policy: facts.score.components.policy,
        dd: facts.score.components.dd,
      },
    },
    aggregates: {
      pnl_r: facts.aggregates.pnl_r,
      car_r: facts.aggregates.car_r,
      dd_r: facts.aggregates.dd_r,
      soft: facts.aggregates.soft,
      hard: facts.aggregates.hard,
      halt: facts.aggregates.halt,
      drain: facts.aggregates.drain,
    },
    outcomes: facts.outcomes.map((o) => ({
      pnl_realized: o.pnl_realized,
      pnl_marked: o.pnl_marked,
      capital_at_risk: o.capital_at_risk,
      fees: o.fees,
      position_delta: o.position_delta,
      drawdown: o.drawdown,
    })),
    policy_events: facts.policyEvents.map((e) => ({
      intent_id: e.intent_id,
      rule_fired: e.rule_fired,
      decision: e.decision,
      severity: e.severity,
    })),
    intent_hashes: [...facts.intentHashes],
    feedback: {
      value: facts.feedback.value.toString(),
      value_decimals: facts.feedback.valueDecimals,
      tag1: facts.feedback.tag1,
      tag2: facts.feedback.tag2,
    },
  };

  const json = canonicalJson(detail);
  return { detail, json, hash: keccak256(toBytes(json)) };
}

/**
 * Re-derive a detail document's hash and compare it to an expected on-chain
 * `feedbackHash`, case-insensitively. Returns `false` (never throws) on any
 * malformed input, so a caller treats a mismatch — tampered/stale bytes — as a
 * clean integrity failure. This is the verifier the endpoint and the e2e
 * integrity checks use.
 */
export function verifyDetailHash(json: string, expectedHash: string): boolean {
  if (typeof json !== 'string' || typeof expectedHash !== 'string') {
    return false;
  }
  let actual: Hex;
  try {
    actual = keccak256(toBytes(json));
  } catch {
    return false;
  }
  return actual.toLowerCase() === expectedHash.toLowerCase();
}
