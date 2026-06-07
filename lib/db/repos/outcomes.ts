import { outcomeRow, type OutcomeRow } from '../schema';
import type { Queryable } from '../types';
import { insertOne, num, selectMany, type NumericInput } from './_shared';

/**
 * Fields accepted when recording an outcome. `execution_id` is optional: the
 * seeded demo arc (rail=seed, §6.5) records outcomes with no execution row.
 */
export interface NewOutcome {
  agent_id: string;
  round_id: string;
  execution_id?: string | null;
  pnl_realized?: NumericInput;
  pnl_marked?: NumericInput;
  capital_at_risk?: NumericInput;
  fees?: NumericInput;
  position_delta?: NumericInput;
  drawdown?: NumericInput;
}

const n = (v: NumericInput | undefined): string | undefined =>
  v === undefined ? undefined : num(v);

export function insertOutcome(db: Queryable, input: NewOutcome): Promise<OutcomeRow> {
  return insertOne(
    db,
    'outcomes',
    {
      agent_id: input.agent_id,
      round_id: input.round_id,
      execution_id: input.execution_id,
      pnl_realized: n(input.pnl_realized),
      pnl_marked: n(input.pnl_marked),
      capital_at_risk: n(input.capital_at_risk),
      fees: n(input.fees),
      position_delta: n(input.position_delta),
      drawdown: n(input.drawdown),
    },
    outcomeRow,
  );
}

/** Agent-detail read: an agent's most recent outcomes across rounds, newest first. */
export function listRecentOutcomesByAgent(
  db: Queryable,
  agentId: string,
  limit = 100,
): Promise<OutcomeRow[]> {
  return selectMany(
    db,
    'SELECT * FROM outcomes WHERE agent_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
    [agentId, limit],
    outcomeRow,
  );
}

export function listOutcomesByAgentRound(
  db: Queryable,
  agentId: string,
  roundId: string,
): Promise<OutcomeRow[]> {
  return selectMany(
    db,
    // `id` tiebreaker keeps the float-summation order in `deriveScoreInputs`
    // deterministic when two outcomes share a `created_at` tick (§6.5).
    'SELECT * FROM outcomes WHERE agent_id = $1 AND round_id = $2 ORDER BY created_at ASC, id ASC',
    [agentId, roundId],
    outcomeRow,
  );
}
