import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from '@neondatabase/serverless';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { listAllocationsByRound } from '@/lib/db/repos/capital-allocations';
import { loadMigrations, migrate, MIGRATIONS_DIR } from '@/lib/db/migrate';
import { listPolicyEventsByAgentRound } from '@/lib/db/repos/policy-events';
import type { Queryable } from '@/lib/db/types';

/**
 * Regression: the per-round reads that feed the deterministic pipeline must
 * impose a **total** order, so rows that share a `created_at` come back in a
 * stable sequence rather than an engine-defined one. `listAllocationsByRound`
 * and `listPolicyEventsByAgentRound` order by `(created_at ASC, id ASC)`.
 *
 * Each test inserts two sibling rows with an *identical* `created_at` and
 * explicit ids, writing the larger id first so a tiebreak-less query (which
 * tends to return heap/insertion order) would yield the reversed sequence.
 * Skipped unless `DATABASE_URL` is set.
 */

const hasDb = typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0;
const describeDb = hasDb ? describe : describe.skip;

const ID_LO = '00000000-0000-0000-0000-0000000000a1';
const ID_HI = '00000000-0000-0000-0000-0000000000a2';
const SAME_TS = '2020-01-01T00:00:00.000Z';

describeDb('per-round reads impose a total order (isolated schema on real Neon)', () => {
  const schema = `vec_test_${randomUUID().replace(/-/g, '')}`;
  let pool: Pool;
  let client: PoolClient;
  let db: Queryable;

  const agentA = randomUUID();
  const agentB = randomUUID();
  const roundId = randomUUID();
  const intentId = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    db = client as unknown as Queryable;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await migrate(pool, loadMigrations(MIGRATIONS_DIR), { direction: 'up', searchPath: schema });

    // Parents (raw, so the test owns ids + timestamps end-to-end).
    await client.query(
      `INSERT INTO agents (id, display_name, owner, strategy_kind) VALUES
         ($1, 'alpha', 'ops', 'seed'), ($2, 'bravo', 'ops', 'seed')`,
      [agentA, agentB],
    );
    await client.query(`INSERT INTO rounds (id, index) VALUES ($1, 0)`, [roundId]);
    await client.query(
      `INSERT INTO intents (id, round_id, agent_id, intent_hash, action)
         VALUES ($1, $2, $3, 'h', 'open')`,
      [intentId, roundId, agentA],
    );
  });

  afterAll(async () => {
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      client.release();
      await pool.end();
    }
  });

  test('listAllocationsByRound: equal created_at → ascending id', async () => {
    // Larger id first; one row per agent (UNIQUE (agent_id, round_id)).
    await client.query(
      `INSERT INTO capital_allocations
         (id, agent_id, round_id, amount, target_weight, prev_weight, delta, trigger, created_at)
       VALUES
         ($1, $2, $3, 100, 0.6, 0, 0.6, 'settle', $5),
         ($4, $6, $3, 100, 0.4, 0, 0.4, 'settle', $5)`,
      [ID_HI, agentB, roundId, ID_LO, SAME_TS, agentA],
    );

    const rows = await listAllocationsByRound(db, roundId);
    expect(rows.map((r) => r.id)).toEqual([ID_LO, ID_HI]);
  });

  test('listPolicyEventsByAgentRound: equal created_at → ascending id', async () => {
    // Larger id first; both rows for the same (agent, round).
    await client.query(
      `INSERT INTO policy_events
         (id, intent_id, agent_id, round_id, rule_fired, decision, severity, created_at)
       VALUES
         ($1, $4, $2, $3, 'r_hi', 'ALLOW', 'none', $5),
         ($6, $4, $2, $3, 'r_lo', 'ALLOW', 'none', $5)`,
      [ID_HI, agentA, roundId, intentId, SAME_TS, ID_LO],
    );

    const rows = await listPolicyEventsByAgentRound(db, agentA, roundId);
    expect(rows.map((r) => r.id)).toEqual([ID_LO, ID_HI]);
  });
});

describe('per-round total order (skipped without DATABASE_URL)', () => {
  test.skipIf(hasDb)('placeholder so the file always reports at least one test', () => {
    expect(hasDb).toBe(false);
  });
});
