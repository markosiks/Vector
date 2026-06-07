import { z } from 'zod';

import { agentRow } from '../schema';
import type { Queryable } from '../types';
import { selectMany } from './_shared';

/**
 * Leaderboard read model — a join across `agents` and `capital_allocations`.
 *
 * This is the one read that genuinely spans two tables (every other read is
 * single-table and lives in its table's repo), so it gets its own module rather
 * than being forced into `agents.ts` or `capital-allocations.ts`. It is
 * read-only: `agents.score_current` is the denormalized cache whose sole writer
 * is the scoring engine (§6.1 step 7); nothing here mutates.
 */

/** An agent row plus its allocation in the requested round (`null` if none). */
const leaderboardRow = agentRow.extend({ allocation_amount: z.string().nullable() });
export type LeaderboardRow = z.infer<typeof leaderboardRow>;

/**
 * Top agents by current score, each LEFT JOINed to its capital allocation in
 * `roundId`. A `null` `roundId` (no round has started) yields every agent with a
 * `null` allocation. Ordering is `score_current DESC, created_at ASC` — the same
 * deterministic tie-break as {@link listAgentsByScore}, so equal scores never
 * reorder between polls — and is served by `idx_agents_score_current`; the join
 * is served by `idx_capital_alloc_agent_round` (`agent_id, round_id`).
 */
export function listLeaderboard(
  db: Queryable,
  roundId: string | null,
  limit = 100,
): Promise<LeaderboardRow[]> {
  if (roundId === null) {
    return selectMany(
      db,
      `SELECT a.*, NULL::numeric AS allocation_amount
         FROM agents a
        ORDER BY a.score_current DESC, a.created_at ASC
        LIMIT $1`,
      [limit],
      leaderboardRow,
    );
  }
  return selectMany(
    db,
    `SELECT a.*, ca.amount AS allocation_amount
       FROM agents a
       LEFT JOIN capital_allocations ca
         ON ca.agent_id = a.id AND ca.round_id = $1
      ORDER BY a.score_current DESC, a.created_at ASC
      LIMIT $2`,
    [roundId, limit],
    leaderboardRow,
  );
}
