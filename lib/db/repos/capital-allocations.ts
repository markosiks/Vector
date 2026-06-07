import { capitalAllocationRow, type AllocationTrigger, type CapitalAllocationRow } from '../schema';
import type { Queryable } from '../types';
import { insertOneOrNull, num, selectMany, type NumericInput } from './_shared';

/** Fields accepted when recording a capital re-allocation (§6.2). */
export interface NewCapitalAllocation {
  agent_id: string;
  round_id: string;
  amount: NumericInput;
  target_weight: NumericInput;
  prev_weight: NumericInput;
  delta: NumericInput;
  trigger: AllocationTrigger;
}

/**
 * Insert one capital allocation, idempotently. The ledger is append-only and
 * each `(agent_id, round_id)` is allocated exactly once, so a replay (settlement
 * re-run, retry after a partial failure) is `ON CONFLICT DO NOTHING` against
 * `UNIQUE (agent_id, round_id)` and returns `null` — the caller re-reads the
 * already-persisted round rather than appending a duplicate that would double
 * the round's `Σ amount`. Mirrors `insertScore`.
 */
export function insertCapitalAllocation(
  db: Queryable,
  input: NewCapitalAllocation,
): Promise<CapitalAllocationRow | null> {
  return insertOneOrNull(
    db,
    'capital_allocations',
    {
      agent_id: input.agent_id,
      round_id: input.round_id,
      amount: num(input.amount),
      target_weight: num(input.target_weight),
      prev_weight: num(input.prev_weight),
      delta: num(input.delta),
      trigger: input.trigger,
    },
    capitalAllocationRow,
    { onConflictDoNothing: ['agent_id', 'round_id'] },
  );
}

export function listAllocationsByRound(
  db: Queryable,
  roundId: string,
): Promise<CapitalAllocationRow[]> {
  return selectMany(
    db,
    'SELECT * FROM capital_allocations WHERE round_id = $1 ORDER BY created_at ASC',
    [roundId],
    capitalAllocationRow,
  );
}
