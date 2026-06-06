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
