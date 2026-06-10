import { scoreRow, type ScoreRow } from '../schema';
import type { Queryable } from '../types';
import { insertOneOrNull, num, selectMany, selectOne, type NumericInput } from './_shared';

/** Fields accepted when recording a per-round score. */
export interface NewScore {
  agent_id: string;
  round_id: string;
  raw_r: NumericInput;
  score_r: NumericInput;
  components_json?: unknown;
}

/**
 * Insert a per-round score, idempotently. The `scores` ledger is append-only and
 * each `(agent_id, round_id)` is scored exactly once, so a replay (retry after a
 * partial failure, settlement re-run) is `ON CONFLICT DO NOTHING` and returns
 * `null` — the caller then re-reads the already-persisted row
 * ({@link getScoreByAgentRound}) and converges the agent cache from it, rather
 * than throwing a raw `23505`. History is never overwritten.
 */
export function insertScore(db: Queryable, input: NewScore): Promise<ScoreRow | null> {
  return insertOneOrNull(
    db,
    'scores',
    {
      agent_id: input.agent_id,
      round_id: input.round_id,
      raw_r: num(input.raw_r),
      score_r: num(input.score_r),
      components_json: input.components_json,
    },
    scoreRow,
    { onConflictDoNothing: ['agent_id', 'round_id'] },
  );
}

/** The agent's score for a specific round, or `null` if not yet scored. */
export function getScoreByAgentRound(
  db: Queryable,
  agentId: string,
  roundId: string,
): Promise<ScoreRow | null> {
  return selectOne(
    db,
    'SELECT * FROM scores WHERE agent_id = $1 AND round_id = $2',
    [agentId, roundId],
    scoreRow,
  );
}

/**
 * Upper bound on the number of score rows returned for the agent-detail EWMA
 * chart. The chart polls on the UI cadence, so an unbounded history would grow
 * the per-poll payload and the SVG path without limit as rounds accumulate —
 * a slow availability drain. The most recent `SCORE_HISTORY_MAX` rounds carry
 * the visible trend; older points add weight, not signal. Generous enough that
 * no realistic deployment is truncated in practice.
 */
export const SCORE_HISTORY_MAX = 1000;

/**
 * Score history for the agent-detail EWMA chart: the most recent
 * `SCORE_HISTORY_MAX` rounds, returned **oldest round first**.
 *
 * Selected and ordered by `rounds.index` (the monotonic round ordinal), **not**
 * `created_at` — the same reason {@link getLatestScoreByAgent} chains off the
 * round, not the wall clock: under backfill, replayed/out-of-order settlement,
 * or same-tx ties (identical `created_at`), insertion order diverges from round
 * order and would render the EWMA curve out of sequence. The inner query takes
 * the newest rounds (`index DESC`); the outer flips them back to ascending for
 * the curve. The `scores.id` tie-break keeps the order total even if two rounds
 * somehow shared an index in malformed data.
 */
export function listScoreHistoryByAgent(
  db: Queryable,
  agentId: string,
  limit: number = SCORE_HISTORY_MAX,
): Promise<ScoreRow[]> {
  return selectMany(
    db,
    `WITH recent AS (
       SELECT s.*, r.index AS round_index
       FROM scores s JOIN rounds r ON r.id = s.round_id
       WHERE s.agent_id = $1
       ORDER BY r.index DESC, s.id DESC
       LIMIT $2
     )
     SELECT * FROM recent ORDER BY round_index ASC, id ASC`,
    [agentId, limit],
    scoreRow,
  );
}

/**
 * The agent's score from the highest-numbered round, or `null` if it has never
 * been scored. The EWMA recursion reads its `score_r` as `Score_{r−1}`; a `null`
 * means the caller seeds the recursion with the low `score_0` prior (§6.1).
 *
 * Ordered by `rounds.index` (the monotonic round ordinal), **not** `created_at`:
 * the recursion must chain off the previous *round*, and wall-clock insertion
 * order diverges from round order under backfill, out-of-order/replayed
 * settlement, or same-transaction ties (where `created_at` is identical).
 */
export function getLatestScoreByAgent(db: Queryable, agentId: string): Promise<ScoreRow | null> {
  return selectOne(
    db,
    `SELECT s.* FROM scores s JOIN rounds r ON r.id = s.round_id
     WHERE s.agent_id = $1 ORDER BY r.index DESC LIMIT 1`,
    [agentId],
    scoreRow,
  );
}
