import { agentRow, type AgentRow, type AgentStatus, type StrategyKind } from '../schema';
import type { Queryable } from '../types';
import { insertOne, num, selectMany, selectOne, type NumericInput } from './_shared';

/** Fields accepted when creating an agent. DB fills id/created_at/defaults. */
export interface NewAgent {
  display_name: string;
  owner: string;
  strategy_kind: StrategyKind;
  status?: AgentStatus;
  agent_id_onchain?: string | null;
  score_current?: NumericInput;
}

export function insertAgent(db: Queryable, input: NewAgent): Promise<AgentRow> {
  return insertOne(
    db,
    'agents',
    {
      display_name: input.display_name,
      owner: input.owner,
      strategy_kind: input.strategy_kind,
      status: input.status,
      agent_id_onchain: input.agent_id_onchain,
      score_current: input.score_current === undefined ? undefined : num(input.score_current),
    },
    agentRow,
  );
}

export function getAgent(db: Queryable, id: string): Promise<AgentRow | null> {
  return selectOne(db, 'SELECT * FROM agents WHERE id = $1', [id], agentRow);
}

/** Leaderboard read: agents ordered by their denormalized current score. */
export function listAgentsByScore(db: Queryable, limit = 100): Promise<AgentRow[]> {
  return selectMany(
    db,
    'SELECT * FROM agents ORDER BY score_current DESC, created_at ASC LIMIT $1',
    [limit],
    agentRow,
  );
}
