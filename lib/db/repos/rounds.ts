import { roundRow, type RoundRow, type RoundState } from '../schema';
import type { Queryable } from '../types';
import { insertOne, selectOne } from './_shared';

/** Fields accepted when creating a round. */
export interface NewRound {
  index: number;
  state?: RoundState;
  seed_ref?: string | null;
}

export function insertRound(db: Queryable, input: NewRound): Promise<RoundRow> {
  return insertOne(
    db,
    'rounds',
    { index: input.index, state: input.state, seed_ref: input.seed_ref },
    roundRow,
  );
}

export function getRound(db: Queryable, id: string): Promise<RoundRow | null> {
  return selectOne(db, 'SELECT * FROM rounds WHERE id = $1', [id], roundRow);
}

export function getRoundByIndex(db: Queryable, index: number): Promise<RoundRow | null> {
  return selectOne(db, 'SELECT * FROM rounds WHERE index = $1', [index], roundRow);
}

/**
 * The current round — the one with the highest `index` — or `null` before any
 * round exists. Ordered by `index` (the monotonic ordinal), not `started_at`,
 * so the "current" round is unambiguous even if rounds were backfilled or two
 * share a wall-clock tick. Used by the leaderboard to label round status and to
 * pick which round's capital allocations to show.
 */
export function getLatestRound(db: Queryable): Promise<RoundRow | null> {
  return selectOne(db, 'SELECT * FROM rounds ORDER BY index DESC LIMIT 1', [], roundRow);
}
