import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from '@neondatabase/serverless';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { insertAgent, listAgentsByScore } from '@/lib/db/repos/agents';
import { listAllocationsByRound } from '@/lib/db/repos/capital-allocations';
import { loadMigrations, migrate, MIGRATIONS_DIR } from '@/lib/db/migrate';
import { insertRound } from '@/lib/db/repos/rounds';
import type { Queryable } from '@/lib/db/types';
import { deriveRouterAgents, loadPrevAllocations, recordRoute } from '@/lib/router/record';
import type { RouterState } from '@/lib/router/types';

/**
 * Integration: `agents` cache → `route()` → write `capital_allocations` → read
 * back, against a real Neon database in a throwaway schema. Verifies the ledger
 * round-trips and that the pool stays conserved across a multi-round chain that
 * includes a crash reroute. Skipped unless `DATABASE_URL` is set.
 */

const hasDb = typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0;
const describeDb = hasDb ? describe : describe.skip;

const POOL_UNITS = 10n ** 24n;

function amountUnits(a: string): bigint {
  const [i, f = ''] = a.split('.');
  return BigInt((i ?? '0') + f.padEnd(18, '0').slice(0, 18));
}

describeDb('capital router persistence (isolated schema on real Neon)', () => {
  const schema = `vec_test_${randomUUID().replace(/-/g, '')}`;
  let pool: Pool;
  let client: PoolClient;
  let db: Queryable;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    db = client as unknown as Queryable;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await migrate(pool, loadMigrations(MIGRATIONS_DIR), { direction: 'up', searchPath: schema });
  });

  afterAll(async () => {
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      client.release();
      await pool.end();
    }
  });

  let idx = 0;
  const nextIndex = () => idx++;

  test('routes scores into capital_allocations, conserves the pool, and reroutes on a crash', async () => {
    // Seed three agents with diverging scores; all eligible.
    const a = await insertAgent(db, {
      display_name: 'alpha',
      owner: 'ops',
      strategy_kind: 'seed',
      score_current: '70',
    });
    const b = await insertAgent(db, {
      display_name: 'bravo',
      owner: 'ops',
      strategy_kind: 'seed',
      score_current: '55',
    });
    const c = await insertAgent(db, {
      display_name: 'charlie',
      owner: 'ops',
      strategy_kind: 'seed',
      score_current: '40',
    });

    // Round 1 — cold start fills to the merit target.
    const round1 = await insertRound(db, { index: nextIndex() });
    let state: RouterState = { tick: 0, cooldownUntilTick: 0 };
    const agents1 = deriveRouterAgents(await listAgentsByScore(db));
    const r1 = await recordRoute({
      db,
      roundId: round1.id,
      agents: agents1,
      prev: [],
      state,
      trigger: 'settle',
    });
    state = r1.result.state;

    const written1 = await listAllocationsByRound(db, round1.id);
    expect(written1.length).toBe(3);
    // The persisted ledger conserves the pool exactly.
    expect(written1.reduce((acc, row) => acc + amountUnits(row.amount), 0n)).toBe(POOL_UNITS);
    // The leader holds the most capital.
    const top = [...written1].sort((x, y) => Number(y.amount) - Number(x.amount))[0];
    expect(top?.agent_id).toBe(a.id);
    // Every row stores the trigger and a consistent delta.
    for (const row of written1) {
      expect(row.trigger).toBe('settle');
      expect(Number(row.delta)).toBeCloseTo(Number(row.target_weight) - Number(row.prev_weight), 8);
    }

    // Round 2 — agent alpha crashes; capital must reroute to bravo & charlie.
    const round2 = await insertRound(db, { index: nextIndex() });
    const prev = await loadPrevAllocations(db, round1.id);
    const agents2 = deriveRouterAgents(await listAgentsByScore(db), {
      crashedAgentIds: new Set([a.id]),
    });
    const r2 = await recordRoute({
      db,
      roundId: round2.id,
      agents: agents2,
      prev,
      state: { tick: state.tick + 1, cooldownUntilTick: state.cooldownUntilTick },
      trigger: 'crash',
    });

    const written2 = await listAllocationsByRound(db, round2.id);
    expect(written2.reduce((acc, row) => acc + amountUnits(row.amount), 0n)).toBe(POOL_UNITS);
    const alpha2 = written2.find((row) => row.agent_id === a.id);
    expect(alpha2 && Number(alpha2.amount)).toBe(0); // drained
    expect(written2.every((row) => row.trigger === 'crash')).toBe(true);
    const bravo2 = written2.find((row) => row.agent_id === b.id);
    expect(bravo2 && Number(bravo2.amount)).toBeGreaterThan(0);
    void c;
    void r2;
  });

  test('a never-funded, never-eligible agent is not written to the ledger', async () => {
    const live = await insertAgent(db, {
      display_name: 'live',
      owner: 'ops',
      strategy_kind: 'seed',
      score_current: '80',
    });
    // A halted agent with no prior capital — immaterial, should be skipped.
    const dormant = await insertAgent(db, {
      display_name: 'dormant',
      owner: 'ops',
      strategy_kind: 'seed',
      score_current: '0',
      status: 'halted',
    });
    const round = await insertRound(db, { index: nextIndex() });
    const all = await listAgentsByScore(db);
    const agents = deriveRouterAgents(all.filter((x) => x.id === live.id || x.id === dormant.id));
    await recordRoute({
      db,
      roundId: round.id,
      agents,
      prev: [],
      state: { tick: 0, cooldownUntilTick: 0 },
      trigger: 'settle',
    });

    const rows = await listAllocationsByRound(db, round.id);
    expect(rows.map((r) => r.agent_id)).toEqual([live.id]); // dormant omitted
    expect(Number(rows[0]?.amount)).toBeGreaterThan(0);
  });
});
