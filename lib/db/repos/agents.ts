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

/** Fields the scoring engine writes to the denormalized agent cache (§6.1 step 7). */
export interface AgentScoreUpdate {
  /** Latest `score_r ∈ [0, 100]`; mirrored into `agents.score_current`. */
  score_current: NumericInput;
  /**
   * Whether this round should gate the agent: a floor-crash (`halt`/drain) or a
   * score below the router's `s_min`. When `true` the status moves to `gated`;
   * otherwise it moves to `active`. An operator `halted` agent is never changed
   * here — un-halting is an operator action, not a side effect of scoring.
   */
  gated: boolean;
}

/**
 * Update an agent's denormalized score cache and gating status — the **single
 * writer** of `agents.score_current` (architecture.txt §6.1 step 7). The status
 * transition is computed in SQL so the read-modify-write is atomic: a `halted`
 * agent keeps its status, otherwise it flips between `gated` and `active` by the
 * `gated` flag. Throws if no agent matches `id`.
 */
export async function updateAgentScore(
  db: Queryable,
  id: string,
  update: AgentScoreUpdate,
): Promise<AgentRow> {
  const { rows } = await db.query(
    `UPDATE agents
        SET score_current = $2,
            status = CASE
              WHEN status = 'halted' THEN status
              WHEN $3 THEN 'gated'::agent_status
              ELSE 'active'::agent_status
            END
      WHERE id = $1
      RETURNING *`,
    [id, num(update.score_current), update.gated],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`updateAgentScore: no agent with id ${id}`);
  }
  return agentRow.parse(row);
}

/**
 * Set an agent's operator-controlled {@link AgentStatus} (P2.4). This is the
 * **operator** writer of `agents.status`, distinct from {@link updateAgentScore}
 * (the scoring engine's writer, which preserves a `halted` status and never
 * touches it). It writes only `status`, leaving `score_current` untouched, so a
 * per-agent HALT/un-HALT is a pure control-plane action.
 *
 * Returns the updated row, or `null` when no agent matches `id` (a well-formed
 * but unknown id — the route maps that to a 404 rather than throwing). The
 * single `UPDATE` is atomic, so concurrent operator writes are last-writer-wins
 * without a torn state.
 */
export async function setAgentStatus(
  db: Queryable,
  id: string,
  status: AgentStatus,
): Promise<AgentRow | null> {
  const { rows } = await db.query('UPDATE agents SET status = $2 WHERE id = $1 RETURNING *', [
    id,
    status,
  ]);
  const row = rows[0];
  return row === undefined ? null : agentRow.parse(row);
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
