import type { Queryable } from './types';

/**
 * Smoke seed + data reset for the Vector data model.
 *
 * `seedSmoke` inserts exactly one row per table with fixed UUIDs, in FK order,
 * using `ON CONFLICT DO NOTHING` so it is idempotent (safe to run repeatedly).
 * It exercises every relation: intent→round/agent, execution→intent,
 * outcome→execution, score/allocation/attestation→agent+round, and the
 * singleton kill switch.
 *
 * `resetData` truncates every table (RESTART IDENTITY, CASCADE) — an idempotent
 * way to return to an empty-but-migrated database.
 */

const ID = {
  agent: '00000000-0000-0000-0000-0000000000a1',
  round: '00000000-0000-0000-0000-0000000000b1',
  intent: '00000000-0000-0000-0000-0000000000c1',
  execution: '00000000-0000-0000-0000-0000000000d1',
  policyEvent: '00000000-0000-0000-0000-0000000000e1',
  outcome: '00000000-0000-0000-0000-0000000000f1',
  score: '00000000-0000-0000-0000-000000000a01',
  allocation: '00000000-0000-0000-0000-000000000b01',
  attestation: '00000000-0000-0000-0000-000000000c01',
} as const;

/** Tables in reverse-FK order, used by `resetData`'s single TRUNCATE. */
const ALL_TABLES = [
  'operator_actions',
  'kill_switch',
  'attestations',
  'capital_allocations',
  'scores',
  'outcomes',
  'executions',
  'policy_events',
  'intents',
  'rounds',
  'agents',
] as const;

export async function seedSmoke(db: Queryable): Promise<void> {
  await db.query(
    `INSERT INTO agents (id, display_name, owner, strategy_kind, status, score_current)
     VALUES ($1, 'seed-leader', 'vector-ops', 'seed', 'active', 50)
     ON CONFLICT (id) DO NOTHING`,
    [ID.agent],
  );

  await db.query(
    `INSERT INTO rounds (id, index, state, seed_ref)
     VALUES ($1, 0, 'open', 'seed/round-0')
     ON CONFLICT (id) DO NOTHING`,
    [ID.round],
  );

  await db.query(
    `INSERT INTO intents (id, round_id, agent_id, intent_hash, action, market, side, size, leverage, max_slippage)
     VALUES ($1, $2, $3, '0xseed-intent', 'open', 'BTC-PERP', 'long', 1000, 2, 0.005)
     ON CONFLICT (id) DO NOTHING`,
    [ID.intent, ID.round, ID.agent],
  );

  await db.query(
    `INSERT INTO executions (id, intent_id, rail, rail_order_id, status)
     VALUES ($1, $2, 'byreal', 'seed-order-1', 'filled')
     ON CONFLICT (id) DO NOTHING`,
    [ID.execution, ID.intent],
  );

  await db.query(
    `INSERT INTO policy_events (id, intent_id, agent_id, round_id, rule_fired, decision, severity)
     VALUES ($1, $2, $3, $4, 'leverage_cap', 'ALLOW', 'none')
     ON CONFLICT (id) DO NOTHING`,
    [ID.policyEvent, ID.intent, ID.agent, ID.round],
  );

  await db.query(
    `INSERT INTO outcomes (id, execution_id, agent_id, round_id, pnl_realized, pnl_marked, capital_at_risk, fees, position_delta, drawdown)
     VALUES ($1, $2, $3, $4, 12.5, 12.5, 1000, 0.4, 1, 0)
     ON CONFLICT (id) DO NOTHING`,
    [ID.outcome, ID.execution, ID.agent, ID.round],
  );

  await db.query(
    `INSERT INTO scores (id, agent_id, round_id, raw_r, score_r, components_json)
     VALUES ($1, $2, $3, 0.42, 50, '{"perf":0.5,"w":0,"policy":0,"dd":0}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [ID.score, ID.agent, ID.round],
  );

  await db.query(
    `INSERT INTO capital_allocations (id, agent_id, round_id, amount, target_weight, prev_weight, delta, trigger)
     VALUES ($1, $2, $3, 1000, 1, 1, 0, 'settle')
     ON CONFLICT (id) DO NOTHING`,
    [ID.allocation, ID.agent, ID.round],
  );

  await db.query(
    `INSERT INTO attestations (id, agent_id, round_id, value, value_decimals, chain_state)
     VALUES ($1, $2, $3, 50, 0, 'optimistic')
     ON CONFLICT (id) DO NOTHING`,
    [ID.attestation, ID.agent, ID.round],
  );

  await db.query(
    `INSERT INTO kill_switch (id, active, reason, set_by)
     VALUES (1, false, NULL, 'seed')
     ON CONFLICT (id) DO NOTHING`,
  );
}

export async function resetData(db: Queryable): Promise<void> {
  // Fail closed if this would run against the default `public` schema. resetData
  // is a destructive TRUNCATE of every table and has no business touching a
  // production database; legitimate callers (tests, local resets) operate inside
  // a dedicated non-public schema via `search_path`. This blocks the footgun of
  // a `public`-bound connection being passed in by mistake.
  const { rows } = await db.query<{ schema: string }>('SELECT current_schema() AS schema');
  if (rows[0]?.schema === 'public') {
    throw new Error('resetData refused: current_schema is "public" (destructive TRUNCATE blocked)');
  }
  await db.query(`TRUNCATE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}
