import { capitalAllocationRow, type AllocationTrigger, type CapitalAllocationRow } from '../schema';
import type { Queryable } from '../types';
import { insertOne, num, selectMany, type NumericInput } from './_shared';

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

export function insertCapitalAllocation(
  db: Queryable,
  input: NewCapitalAllocation,
): Promise<CapitalAllocationRow> {
  return insertOne(
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
