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

/**
 * Scoring read: a round's outcomes **excluding the live Byreal rail** (P2.1, §3).
 *
 * The Byreal credibility rail writes real `outcomes` rows linked to a
 * `rail = 'byreal'` execution. Those are shown alongside the demo but must never
 * feed the deterministic score — a live venue's non-deterministic PnL would
 * break the arc's reproducibility (the determinism boundary). The scoring path
 * therefore reads only the seeded fills (`rail = 'seed'`) plus any outcome with
 * no execution row (defensive: the repo permits a NULL `execution_id`), and
 * leaves Byreal outcomes for the credibility surface alone.
 *
 * When the Byreal rail is disabled (the default) every outcome is seeded, so this
 * returns exactly the same rows as {@link listOutcomesByAgentRound} — the demo
 * arc stays byte-identical.
 */
export function listSeedOutcomesByAgentRound(
  db: Queryable,
  agentId: string,
  roundId: string,
): Promise<OutcomeRow[]> {
  return selectMany(
    db,
    `SELECT o.* FROM outcomes o
       LEFT JOIN executions e ON e.id = o.execution_id
      WHERE o.agent_id = $1 AND o.round_id = $2
        AND (e.rail = 'seed' OR o.execution_id IS NULL)
      ORDER BY o.created_at ASC, o.id ASC`,
    [agentId, roundId],
    outcomeRow,
  );
}
