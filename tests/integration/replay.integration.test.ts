import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from '@neondatabase/serverless';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { loadMigrations, migrate, MIGRATIONS_DIR } from '@/lib/db/migrate';
import type { Queryable } from '@/lib/db/types';
import { runArc } from '@/lib/replay';
import { buildDemoArc } from '@/seed';

/**
 * Integration: the full demo spine against a real Neon database in a throwaway
 * schema (§6.5). Runs a short arc end to end through the *real* referee, scoring,
 * and router, then asserts the persisted facts:
 *  - normal ticks write intents → policy_events → executions(rail=seed) → outcomes;
 *  - each round settle writes scores and the next round's capital_allocations;
 *  - the injected drain is blocked (rule #3) and crashes the leader;
 *  - the leader's capital reroutes to the runner-up, with the pool conserved.
 * Skipped unless `DATABASE_URL` is set.
 */

const hasDb = typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0;
const describeDb = hasDb ? describe : describe.skip;

const POOL_UNITS = 10n ** 24n; // pool_size (1e6) × 1e18 amount scale.

function amountUnits(a: string): bigint {
  const [i, f = ''] = a.split('.');
  return BigInt((i ?? '0') + f.padEnd(18, '0').slice(0, 18));
}

describeDb('demo spine end-to-end (isolated schema on real Neon)', () => {
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

  async function count(sql: string): Promise<number> {
    const { rows } = await client.query(sql);
    return Number((rows[0] as { n: string }).n);
  }

  test('runs the arc through the real pipeline and persists a conserved, rerouted end-state', async () => {
    const arc = buildDemoArc({ rounds: 3 }); // 15 ticks; attack on round-1 settle (tick 9).
    const result = await runArc(db, arc);

    expect(result.rounds).toBe(3);
    expect(result.ticks).toBe(15);

    // Normal ticks produced the full intent → execution(seed) → outcome chain.
    expect(await count('SELECT count(*) n FROM intents')).toBeGreaterThan(0);
    expect(await count("SELECT count(*) n FROM executions WHERE rail = 'seed'")).toBeGreaterThan(0);
    expect(await count('SELECT count(*) n FROM outcomes')).toBeGreaterThan(0);

    // Settles scored every agent each round and allocated capital each round.
    expect(await count('SELECT count(*) n FROM scores')).toBe(arc.agentIds.length * 3);
    expect(await count('SELECT count(DISTINCT round_id) n FROM capital_allocations')).toBe(3);

    // The injected drain was blocked by referee rule #3 and crashed the leader.
    expect(
      await count(
        "SELECT count(*) n FROM policy_events WHERE rule_fired = 'fresh_wallet_transfer_block' AND decision = 'REJECT' AND severity = 'hard'",
      ),
    ).toBe(1);
    expect(result.crashedAgentIds).toContain('seed-leader');

    // Capital rerouted: the crashed leader holds nothing; the runner-up holds the
    // pool; and the total is conserved to the last unit.
    const byAgent = new Map(result.finalAllocations.map((a) => [a.agentId, a.amount]));
    expect(amountUnits(byAgent.get('seed-leader') ?? '0')).toBe(0n);
    expect(amountUnits(byAgent.get('seed-2') ?? '0')).toBeGreaterThan(0n);
    const total = result.finalAllocations.reduce((acc, a) => acc + amountUnits(a.amount), 0n);
    expect(total).toBe(POOL_UNITS);

    // Idempotency: re-running the identical arc reserves no new nonces and writes
    // no duplicate agents/rounds/scores (insert-reserving + ON CONFLICT converge).
    const agentsBefore = await count("SELECT count(*) n FROM agents WHERE strategy_kind = 'seed'");
    const scoresBefore = await count('SELECT count(*) n FROM scores');
    await runArc(db, arc);
    expect(await count("SELECT count(*) n FROM agents WHERE strategy_kind = 'seed'")).toBe(
      agentsBefore,
    );
    expect(await count('SELECT count(*) n FROM scores')).toBe(scoresBefore);
  });
});
