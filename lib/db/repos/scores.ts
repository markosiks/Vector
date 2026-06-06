import { scoreRow, type ScoreRow } from '../schema';
import type { Queryable } from '../types';
import { insertOne, num, selectMany, selectOne, type NumericInput } from './_shared';

/** Fields accepted when recording a per-round score. */
export interface NewScore {
  agent_id: string;
  round_id: string;
  raw_r: NumericInput;
  score_r: NumericInput;
  components_json?: unknown;
}

export function insertScore(db: Queryable, input: NewScore): Promise<ScoreRow> {
  return insertOne(
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
  );
}

/** Score history for an agent, oldest first (for the agent-detail chart). */
export function listScoresByAgent(db: Queryable, agentId: string): Promise<ScoreRow[]> {
  return selectMany(
    db,
    'SELECT * FROM scores WHERE agent_id = $1 ORDER BY created_at ASC',
    [agentId],
    scoreRow,
  );
}

/**
 * The agent's most recent score row, or `null` if it has never been scored.
 * The EWMA recursion reads its `score_r` as `Score_{r−1}`; a `null` means the
 * caller seeds the recursion with the low `score_0` prior (§6.1).
 */
export function getLatestScoreByAgent(db: Queryable, agentId: string): Promise<ScoreRow | null> {
  return selectOne(
    db,
    'SELECT * FROM scores WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1',
    [agentId],
    scoreRow,
  );
}
