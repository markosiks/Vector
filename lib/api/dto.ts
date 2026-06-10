import { z } from 'zod';

import {
  AGENT_STATUS,
  type AgentRow,
  ALLOCATION_TRIGGER,
  type AttestationRow,
  type CapitalAllocationRow,
  CHAIN_STATE,
  INTENT_ACTION,
  INTENT_SIDE,
  type IntentRow,
  type KillSwitchRow,
  OPERATOR_ACTION_KIND,
  type OperatorActionRow,
  type OutcomeRow,
  POLICY_DECISION,
  POLICY_SEVERITY,
  type PolicyEventRow,
  type RoundRow,
  ROUND_STATE,
  type ScoreRow,
  scoreComponents,
  STRATEGY_KIND,
} from '../db/schema';
import type { LeaderboardRow } from '../db/repos/leaderboard';
import type { AttackInjectionResult } from '../operator/inject-attack';

/**
 * Stable, versioned response DTOs for the read API and the pure mappers that
 * build them from database rows.
 *
 * Two invariants the UI and the on-chain story both depend on:
 *
 *  1. **Precision is never lost.** Every money / score / capital-at-risk column
 *     is Postgres `numeric`, surfaced by the driver as a decimal *string*; it
 *     stays a string end-to-end. Routing one through a JS `number` would corrupt
 *     a `numeric(38,18)` position or a 39-digit attestation value, so the DTOs
 *     carry these as `string`, not `number`.
 *  2. **Nothing internal leaks.** Each mapper names exactly the fields it emits.
 *     The intent DTO deliberately omits `signature`, `raw_json`, and `nonce`:
 *     the UI never needs them and they are not the read API's to expose.
 *
 * `created_at`/`*_at` are emitted as ISO-8601 strings (the driver hands us a
 * `Date`; JSON has no date type) so clients get one canonical, sortable form.
 */

// --- Reusable codecs --------------------------------------------------------
/** A Postgres `numeric`, carried as an exact decimal string. */
const numeric = z.string();
/** An ISO-8601 timestamp string (a serialized `timestamptz`). */
const isoTime = z.string();

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

// --- Round ------------------------------------------------------------------
export const roundDto = z.object({
  id: z.string().uuid(),
  index: z.number().int(),
  state: z.enum(ROUND_STATE),
  started_at: isoTime,
  settled_at: isoTime.nullable(),
});
export type RoundDto = z.infer<typeof roundDto>;

export function toRoundDto(r: RoundRow): RoundDto {
  return {
    id: r.id,
    index: r.index,
    state: r.state,
    started_at: iso(r.started_at),
    settled_at: isoOrNull(r.settled_at),
  };
}

// --- Agent ------------------------------------------------------------------
export const agentDto = z.object({
  id: z.string().uuid(),
  display_name: z.string(),
  owner: z.string(),
  strategy_kind: z.enum(STRATEGY_KIND),
  status: z.enum(AGENT_STATUS),
  score_current: numeric,
  agent_id_onchain: z.string().nullable(),
  created_at: isoTime,
});
export type AgentDto = z.infer<typeof agentDto>;

export function toAgentDto(a: AgentRow): AgentDto {
  return {
    id: a.id,
    display_name: a.display_name,
    owner: a.owner,
    strategy_kind: a.strategy_kind,
    status: a.status,
    score_current: a.score_current,
    agent_id_onchain: a.agent_id_onchain,
    created_at: iso(a.created_at),
  };
}

// --- Leaderboard ------------------------------------------------------------
export const leaderboardEntryDto = agentDto.extend({
  /** Capital allocated to this agent in the current round, or `null` if none. */
  allocation: numeric.nullable(),
});
export type LeaderboardEntryDto = z.infer<typeof leaderboardEntryDto>;

export const leaderboardDto = z.object({
  /** The round the allocations are drawn from, or `null` before any round. */
  round: roundDto.nullable(),
  /** Label for the capital units, from `CONFIG.capital.capital_unit_label`. */
  capital_unit: z.string(),
  data: z.array(leaderboardEntryDto),
});
export type LeaderboardDto = z.infer<typeof leaderboardDto>;

export function toLeaderboardEntryDto(row: LeaderboardRow): LeaderboardEntryDto {
  return {
    id: row.id,
    display_name: row.display_name,
    owner: row.owner,
    strategy_kind: row.strategy_kind,
    status: row.status,
    score_current: row.score_current,
    agent_id_onchain: row.agent_id_onchain,
    allocation: row.allocation_amount,
    created_at: iso(row.created_at),
  };
}

// --- Score ------------------------------------------------------------------
export const scoreDto = z.object({
  round_id: z.string().uuid(),
  raw_r: numeric,
  score_r: numeric,
  components: scoreComponents.nullable(),
  created_at: isoTime,
});
export type ScoreDto = z.infer<typeof scoreDto>;

export function toScoreDto(s: ScoreRow): ScoreDto {
  return {
    round_id: s.round_id,
    raw_r: s.raw_r,
    score_r: s.score_r,
    components: s.components_json,
    created_at: iso(s.created_at),
  };
}

// --- Intent -----------------------------------------------------------------
/** Public intent shape. Omits `signature`, `raw_json`, `nonce` (never exposed). */
export const intentDto = z.object({
  id: z.string().uuid(),
  round_id: z.string().uuid(),
  intent_hash: z.string(),
  action: z.enum(INTENT_ACTION),
  market: z.string().nullable(),
  side: z.enum(INTENT_SIDE).nullable(),
  size: numeric.nullable(),
  leverage: numeric.nullable(),
  tp: numeric.nullable(),
  sl: numeric.nullable(),
  max_slippage: numeric.nullable(),
  target_address: z.string().nullable(),
  created_at: isoTime,
});
export type IntentDto = z.infer<typeof intentDto>;

export function toIntentDto(i: IntentRow): IntentDto {
  return {
    id: i.id,
    round_id: i.round_id,
    intent_hash: i.intent_hash,
    action: i.action,
    market: i.market,
    side: i.side,
    size: i.size,
    leverage: i.leverage,
    tp: i.tp,
    sl: i.sl,
    max_slippage: i.max_slippage,
    target_address: i.target_address,
    created_at: iso(i.created_at),
  };
}

// --- Policy event -----------------------------------------------------------
export const policyEventDto = z.object({
  id: z.string().uuid(),
  intent_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  round_id: z.string().uuid(),
  rule_fired: z.string(),
  decision: z.enum(POLICY_DECISION),
  severity: z.enum(POLICY_SEVERITY),
  // Typed as a string-keyed record rather than z.unknown() to prevent silent
  // passthrough of any future sensitive fields stored in detail_json (F-05).
  // Non-object values (null, primitives) are preserved as-is.
  detail: z.union([z.record(z.string(), z.unknown()), z.null()]),
  created_at: isoTime,
});
export type PolicyEventDto = z.infer<typeof policyEventDto>;

export function toPolicyEventDto(e: PolicyEventRow): PolicyEventDto {
  return {
    id: e.id,
    intent_id: e.intent_id,
    agent_id: e.agent_id,
    round_id: e.round_id,
    rule_fired: e.rule_fired,
    decision: e.decision,
    severity: e.severity,
    // Cast: detail_json is an object stored by the referee; the DTO type
    // narrows it to Record<string,unknown>|null for forward-safety (F-05).
    detail: e.detail_json as Record<string, unknown> | null,
    created_at: iso(e.created_at),
  };
}

// --- Outcome ----------------------------------------------------------------
export const outcomeDto = z.object({
  id: z.string().uuid(),
  round_id: z.string().uuid(),
  execution_id: z.string().uuid().nullable(),
  pnl_realized: numeric,
  pnl_marked: numeric,
  capital_at_risk: numeric,
  fees: numeric,
  position_delta: numeric,
  drawdown: numeric,
  created_at: isoTime,
});
export type OutcomeDto = z.infer<typeof outcomeDto>;

export function toOutcomeDto(o: OutcomeRow): OutcomeDto {
  return {
    id: o.id,
    round_id: o.round_id,
    execution_id: o.execution_id,
    pnl_realized: o.pnl_realized,
    pnl_marked: o.pnl_marked,
    capital_at_risk: o.capital_at_risk,
    fees: o.fees,
    position_delta: o.position_delta,
    drawdown: o.drawdown,
    created_at: iso(o.created_at),
  };
}

// --- Capital allocation -----------------------------------------------------
export const allocationDto = z.object({
  id: z.string().uuid(),
  agent_id: z.string().uuid(),
  round_id: z.string().uuid(),
  amount: numeric,
  target_weight: numeric,
  prev_weight: numeric,
  delta: numeric,
  trigger: z.enum(ALLOCATION_TRIGGER),
  created_at: isoTime,
});
export type AllocationDto = z.infer<typeof allocationDto>;

export function toAllocationDto(a: CapitalAllocationRow): AllocationDto {
  return {
    id: a.id,
    agent_id: a.agent_id,
    round_id: a.round_id,
    amount: a.amount,
    target_weight: a.target_weight,
    prev_weight: a.prev_weight,
    delta: a.delta,
    trigger: a.trigger,
    created_at: iso(a.created_at),
  };
}

// --- Attestation ------------------------------------------------------------
export const attestationDto = z.object({
  id: z.string().uuid(),
  agent_id: z.string().uuid(),
  round_id: z.string().uuid(),
  value: numeric,
  value_decimals: z.number().int(),
  tag1: z.string().nullable(),
  tag2: z.string().nullable(),
  feedback_uri: z.string().nullable(),
  feedback_hash: z.string().nullable(),
  chain_state: z.enum(CHAIN_STATE),
  tx_hash: z.string().nullable(),
  block_number: z.string().nullable(),
  created_at: isoTime,
  confirmed_at: isoTime.nullable(),
});
export type AttestationDto = z.infer<typeof attestationDto>;

export function toAttestationDto(a: AttestationRow): AttestationDto {
  return {
    id: a.id,
    agent_id: a.agent_id,
    round_id: a.round_id,
    value: a.value,
    value_decimals: a.value_decimals,
    tag1: a.tag1,
    tag2: a.tag2,
    feedback_uri: a.feedback_uri,
    feedback_hash: a.feedback_hash,
    chain_state: a.chain_state,
    tx_hash: a.tx_hash,
    block_number: a.block_number,
    created_at: iso(a.created_at),
    confirmed_at: isoOrNull(a.confirmed_at),
  };
}

// --- Agent detail (composite) ----------------------------------------------
export const agentDetailDto = z.object({
  agent: agentDto,
  scores: z.array(scoreDto),
  intents: z.array(intentDto),
  policy_events: z.array(policyEventDto),
  outcomes: z.array(outcomeDto),
});
export type AgentDetailDto = z.infer<typeof agentDetailDto>;

// --- Operator console (P2.4) ------------------------------------------------
/** The global kill switch as the operator console renders it. */
export const killSwitchDto = z.object({
  active: z.boolean(),
  reason: z.string().nullable(),
  set_by: z.string().nullable(),
  updated_at: isoTime.nullable(),
});
export type KillSwitchDto = z.infer<typeof killSwitchDto>;

/**
 * Map the kill-switch singleton to its DTO. A `null` row (no toggle has ever
 * been written) is the fail-open default: inactive, no reason.
 */
export function toKillSwitchDto(row: KillSwitchRow | null): KillSwitchDto {
  return {
    active: row?.active ?? false,
    reason: row?.reason ?? null,
    set_by: row?.set_by ?? null,
    updated_at: row === null ? null : iso(row.updated_at),
  };
}

/** One row of the operator audit feed. */
export const operatorActionDto = z.object({
  id: z.string().uuid(),
  kind: z.enum(OPERATOR_ACTION_KIND),
  actor: z.string(),
  agent_id: z.string().uuid().nullable(),
  // Typed as a string-keyed record rather than z.unknown() to prevent silent
  // passthrough of any future sensitive fields stored in detail_json (F-05).
  // Non-object values (null, primitives) are preserved as-is.
  detail: z.union([z.record(z.string(), z.unknown()), z.null()]),
  created_at: isoTime,
});
export type OperatorActionDto = z.infer<typeof operatorActionDto>;

export function toOperatorActionDto(a: OperatorActionRow): OperatorActionDto {
  return {
    id: a.id,
    kind: a.kind,
    actor: a.actor,
    agent_id: a.agent_id,
    // Cast: detail_json is an object stored by the operator layer; the DTO
    // type narrows it to Record<string,unknown>|null for forward-safety (F-05).
    detail: a.detail_json as Record<string, unknown> | null,
    created_at: iso(a.created_at),
  };
}

/** The console's full hydration payload (auth-gated). */
export const operatorStateDto = z.object({
  kill_switch: killSwitchDto,
  agents: z.array(leaderboardEntryDto),
  capital_unit: z.string(),
  round: roundDto.nullable(),
  recent_actions: z.array(operatorActionDto),
});
export type OperatorStateDto = z.infer<typeof operatorStateDto>;

/** The result of a scripted-attack injection, returned to the console. */
export const attackResultDto = z.object({
  /** REJECT (the drain block) or HALT (a global/per-agent stop was active). */
  decision: z.enum(POLICY_DECISION),
  severity: z.enum(POLICY_SEVERITY),
  rule_fired: z.string(),
  /** The persisted Intent id, or `null` for an idempotent retry. */
  intent_id: z.string().uuid().nullable(),
  intent_hash: z.string(),
  /** True when this click duplicated an earlier one (no new rows written). */
  duplicate: z.boolean(),
  /** The agent the drain targeted. */
  target_agent_id: z.string().uuid(),
  target_display_name: z.string(),
});
export type AttackResultDto = z.infer<typeof attackResultDto>;

export function toAttackResultDto(r: AttackInjectionResult): AttackResultDto {
  return {
    decision: r.decision.decision,
    severity: r.decision.severity,
    rule_fired: r.decision.rule_fired,
    intent_id: r.intentId,
    intent_hash: r.intentHash,
    duplicate: r.duplicate,
    target_agent_id: r.target.leader.id,
    target_display_name: r.target.leader.display_name,
  };
}
