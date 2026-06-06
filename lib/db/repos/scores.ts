import { scoreRow, type ScoreRow } from '../schema';
import type { Queryable } from '../types';
import { insertOne, num, selectMany, type NumericInput } from './_shared';

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
