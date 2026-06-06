import { CONFIG } from '@/lib/config/constants';
import { updateAgentScore } from '@/lib/db/repos/agents';
import { getLatestScoreByAgent, insertScore } from '@/lib/db/repos/scores';
import type { AgentRow, OutcomeRow, PolicyEventRow, ScoreRow } from '@/lib/db/schema';
import type { Queryable } from '@/lib/db/types';

import { score, type ScoringConfig } from './score';
import type { ScoreInputs, ScoreResult } from './types';

/** `rule_fired` value the referee writes for a confirmed drain (rule #3, §6.3). */
const DRAIN_RULE = 'fresh_wallet_transfer_block';

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
 *  - counts   = number of events per `severity` (`soft`/`hard`/`halt`);
 *  - `drain_r`= any event fired rule #3 (`fresh_wallet_transfer_block`).
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

  let soft = 0;
  let hard = 0;
  let halt = 0;
  let drain_r = false;
  for (const e of policyEvents) {
    if (e.severity === 'soft') soft += 1;
    else if (e.severity === 'hard') hard += 1;
    else if (e.severity === 'halt') halt += 1;
    if (e.rule_fired === DRAIN_RULE) drain_r = true;
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
 * untouched by {@link updateAgentScore}). The two writes are sequential, not in
 * one transaction — the caller settling a round should wrap it if atomicity
 * across agents is required; per-agent the `scores` UNIQUE(agent_id, round_id)
 * already makes a re-run idempotent at the insert.
 */
export async function recordScore(args: RecordScoreArgs): Promise<RecordScoreResult> {
  const scoring = args.scoring ?? CONFIG.scoring;
  const sMin = args.sMin ?? CONFIG.router.s_min;

  const prevScore = args.prevScore ?? (await previousScore(args.db, args.agentId, scoring));
  const result = score(args.inputs, prevScore, scoring);

  const row = await insertScore(args.db, {
    agent_id: args.agentId,
    round_id: args.roundId,
    raw_r: result.raw_r,
    score_r: result.score_r,
    components_json: result.components,
  });

  const gated = result.crashed || Number(result.score_r) < sMin;
  const agent = await updateAgentScore(args.db, args.agentId, {
    score_current: result.score_r,
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
