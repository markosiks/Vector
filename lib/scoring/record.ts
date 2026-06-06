import { CONFIG } from '@/lib/config/constants';
import { updateAgentScore } from '@/lib/db/repos/agents';
import { getLatestScoreByAgent, getScoreByAgentRound, insertScore } from '@/lib/db/repos/scores';
import type { AgentRow, OutcomeRow, PolicyEventRow, ScoreRow } from '@/lib/db/schema';
import type { Queryable } from '@/lib/db/types';
import { FRESH_WALLET_TRANSFER_BLOCK_RULE } from '@/lib/referee/rules/transfer-block';

import { score, type ScoringConfig } from './score';
import type { ScoreInputs, ScoreResult } from './types';

/** `rule_fired` value the referee writes for a confirmed drain (rule #3, §6.3). */
const DRAIN_RULE = FRESH_WALLET_TRANSFER_BLOCK_RULE;

/**
 * `rule_fired` values that are *meta* events, not agent policy violations: the
 * referee's own fail-closed infrastructure error, the pre-evaluation schema
 * gate, and the explicit allow. They must not count toward `soft`/`hard`/`halt`
 * — an `internal_error` is written with `severity:'hard'` so the *execution*
 * gate fails closed, but penalizing the *agent's* reputation for the platform's
 * fault is wrong (and a griefing lever if the fault is reachable from input).
 */
const META_RULES: ReadonlySet<string> = new Set(['internal_error', 'pre_validation', 'allow']);

/** Orders severities so the worst decision per intent dominates (§6.3). */
const SEVERITY_RANK: Record<string, number> = { none: 0, soft: 1, hard: 2, halt: 3 };

/**
 * Reduce one round's persisted facts into {@link ScoreInputs}.
 *
 * The caller passes the outcomes and policy events already scoped to one agent
 * and one round (`listOutcomesByAgentRound` + `listPolicyEventsByAgentRound`).
 * Aggregation rules:
 *  - `pnl_r`  = Σ(`pnl_realized` + `pnl_marked`) across the round's outcomes;
 *  - `car_r`  = Σ `capital_at_risk` (time-weighted `|notional|` is precomputed
 *               per outcome upstream); never trade count or volume;
 *  - `dd_r`   = max `drawdown` across outcomes (already a fraction of allocation);
 *  - counts   = number of distinct *intents* per worst `severity`
 *               (`soft`/`hard`/`halt`) — see below;
 *  - `drain_r`= any event fired rule #3 (`fresh_wallet_transfer_block`).
 *
 * `policy_events` is an append-only, *per-evaluation* audit log: re-evaluating
 * an intent (retry, settlement re-run) appends another row, so counting raw rows
 * would penalize one violation N times. We therefore count one violation per
 * distinct `intent_id`, taking that intent's worst severity. Meta events
 * ({@link META_RULES}) — infrastructure errors, the pre-validation gate, allows
 * — are skipped: they are not agent policy violations.
 *
 * The `numeric` strings are parsed to JS numbers here because the score math is
 * inherently real-valued (`tanh`, EWMA); exactness is preserved where it
 * matters — the *stored* `raw_r`/`score_r` are fixed-scale strings ({@link score}).
 * A malformed (non-numeric) cell throws via `Number` → `requireFinite` downstream.
 */
export function deriveScoreInputs(
  outcomes: readonly OutcomeRow[],
  policyEvents: readonly PolicyEventRow[],
): ScoreInputs {
  let pnl_r = 0;
  let car_r = 0;
  let dd_r = 0;
  for (const o of outcomes) {
    pnl_r += Number(o.pnl_realized) + Number(o.pnl_marked);
    car_r += Number(o.capital_at_risk);
    dd_r = Math.max(dd_r, Number(o.drawdown));
  }

  // Worst decision-bearing severity per distinct intent (dedup of re-evaluations).
  const worstByIntent = new Map<string, string>();
  let drain_r = false;
  for (const e of policyEvents) {
    if (META_RULES.has(e.rule_fired)) continue;
    if (e.rule_fired === DRAIN_RULE) drain_r = true;
    const current = worstByIntent.get(e.intent_id);
    if (current === undefined || (SEVERITY_RANK[e.severity] ?? 0) > (SEVERITY_RANK[current] ?? 0)) {
      worstByIntent.set(e.intent_id, e.severity);
    }
  }

  let soft = 0;
  let hard = 0;
  let halt = 0;
  for (const severity of worstByIntent.values()) {
    if (severity === 'soft') soft += 1;
    else if (severity === 'hard') hard += 1;
    else if (severity === 'halt') halt += 1;
  }

  return { pnl_r, car_r, soft, hard, halt, dd_r, drain_r };
}

/** Arguments for {@link recordScore}. */
export interface RecordScoreArgs {
  readonly db: Queryable;
  /** `agents.id` (uuid). */
  readonly agentId: string;
  /** `rounds.id` (uuid). */
  readonly roundId: string;
  readonly inputs: ScoreInputs;
  /**
   * `Score_{r−1}`. Omit to read it from the agent's latest `scores` row (or the
   * `score_0` prior when the agent has never been scored).
   */
  readonly prevScore?: number;
  /** Defaults to the seeded `CONFIG.scoring`. */
  readonly scoring?: ScoringConfig;
  /** Minimum eligible score; below it (or on a floor-crash) the agent gates. Defaults to `CONFIG.router.s_min`. */
  readonly sMin?: number;
}

/** Result of {@link recordScore}: the computation, the inserted row, the updated agent. */
export interface RecordScoreResult {
  readonly result: ScoreResult;
  readonly row: ScoreRow;
  readonly agent: AgentRow;
}

/**
 * Score one round and persist it: insert the `scores` row (`raw_r`, `score_r`,
 * `components_json`) and update the agent's denormalized cache and gating status
 * (§6.1 step 7). This is the only path that writes `agents.score_current`.
 *
 * Gating: a floor-crash (`halt`/drain) or a new score below `s_min` moves the
 * agent to `gated`; otherwise to `active` (an operator-`halted` agent is left
 * untouched by {@link updateAgentScore}).
 *
 * Recovery / idempotency: the two writes (insert `scores`, update `agents`) are
 * sequential. The score insert is `ON CONFLICT DO NOTHING`, so a replay after a
 * partial failure (or a settlement re-run) re-reads the already-persisted score
 * and **still converges the agent gate from it** — a crash that failed to gate
 * on the first attempt is healed on retry, rather than left fail-open forever by
 * a thrown duplicate-key. The gate is derived from the *persisted* `score_r`
 * (the source of truth), not the recomputed value.
 *
 * Concurrency / atomicity: this is a read-modify-write (prior → score → gate).
 * A caller running concurrent rounds for the same agent **must** pass a single
 * transaction-bound client and serialize the agent (e.g. `SELECT … FOR UPDATE`
 * on the `agents` row) so the EWMA prior cannot be read stale; passing the
 * shared pool is unsafe for that case. P1.2 ships no such caller yet.
 */
export async function recordScore(args: RecordScoreArgs): Promise<RecordScoreResult> {
  const scoring = args.scoring ?? CONFIG.scoring;
  const sMin = args.sMin ?? CONFIG.router.s_min;

  const prevScore = args.prevScore ?? (await previousScore(args.db, args.agentId, scoring));
  const result = score(args.inputs, prevScore, scoring);

  // Idempotent insert: `null` means this round was already scored — re-read the
  // immutable persisted row and converge the gate from it instead of throwing.
  const inserted = await insertScore(args.db, {
    agent_id: args.agentId,
    round_id: args.roundId,
    raw_r: result.raw_r,
    score_r: result.score_r,
    components_json: result.components,
  });
  const row = inserted ?? (await getScoreByAgentRound(args.db, args.agentId, args.roundId));
  if (row === null) {
    throw new Error(
      `recordScore: score row missing for agent ${args.agentId} round ${args.roundId}`,
    );
  }

  // Gate from the persisted score (3-dp, bounded [0,100] ⇒ exactly representable,
  // so the float compare is exact). `crashed` is input-derived (halt/drain) and
  // stable across replays; a crash always lands ≤ crash_cap < s_min, so the
  // score threshold alone would also gate it — the flag makes intent explicit.
  const gated = result.crashed || Number(row.score_r) < sMin;
  const agent = await updateAgentScore(args.db, args.agentId, {
    score_current: row.score_r,
    gated,
  });

  return { result, row, agent };
}

/**
 * `Score_{r−1}` for an agent: the latest persisted `score_r`, or the low
 * `score_0` prior when the agent has never been scored (§6.1: trust is earned).
 */
export async function previousScore(
  db: Queryable,
  agentId: string,
  scoring: ScoringConfig = CONFIG.scoring,
): Promise<number> {
  const latest = await getLatestScoreByAgent(db, agentId);
  return latest === null ? scoring.score_0 : Number(latest.score_r);
}
