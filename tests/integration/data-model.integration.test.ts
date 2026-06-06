import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from '@neondatabase/serverless';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { loadMigrations, migrate, MIGRATIONS_DIR } from '@/lib/db/migrate';
import { insertAgent, listAgentsByScore } from '@/lib/db/repos/agents';
import { insertAttestation } from '@/lib/db/repos/attestations';
import { insertIntent } from '@/lib/db/repos/intents';
import { getKillSwitch } from '@/lib/db/repos/kill-switch';
import { insertRound } from '@/lib/db/repos/rounds';
import { resetData, seedSmoke } from '@/lib/db/seed';
import type { Queryable } from '@/lib/db/types';

/**
 * Integration tests against a **real** Neon database, isolated in a throwaway
 * schema so they neither see nor pollute other data and can run concurrently.
 * Skipped unless `DATABASE_URL` is set:
 *
 *   DATABASE_URL='postgresql://…' bun run test:integration
 */

const hasDb = typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0;
const describeDb = hasDb ? describe : describe.skip;

describeDb('Vector data model (isolated schema on real Neon)', () => {
  const schema = `vec_test_${randomUUID().replace(/-/g, '')}`;
  let pool: Pool;
  let client: PoolClient;
  let db: Queryable & { query: PoolClient['query'] };

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    db = client as unknown as Queryable & { query: PoolClient['query'] };
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    // Apply migrations into the throwaway schema via the real runner.
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

  test('migration created every table and its indexes', async () => {
    const { rows: tables } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [schema],
    );
    const names = new Set(tables.map((t) => t.table_name));
    for (const t of [
      'agents',
      'rounds',
      'intents',
      'policy_events',
      'executions',
      'outcomes',
      'scores',
      'capital_allocations',
      'attestations',
      'kill_switch',
      'schema_migrations',
    ]) {
      expect(names.has(t)).toBe(true);
    }

    const { rows: idx } = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1`,
      [schema],
    );
    const idxNames = new Set(idx.map((i) => i.indexname));
    for (const i of [
      'idx_agents_score_current',
      'idx_policy_events_created',
      'idx_attestations_chain_state',
      'idx_intents_agent_created',
    ]) {
      expect(idxNames.has(i)).toBe(true);
    }
  });

  test('happy path: seed, then read intent→round→agent and the leaderboard', async () => {
    await seedSmoke(db);
    const board = await listAgentsByScore(db, 10);
    expect(board.length).toBeGreaterThanOrEqual(1);

    const { rows } = await db.query<{ display_name: string; index: number }>(
      `SELECT a.display_name, r.index
         FROM intents i
         JOIN rounds r ON r.id = i.round_id
         JOIN agents a ON a.id = i.agent_id
        LIMIT 1`,
    );
    expect(rows[0]?.display_name).toBe('seed-leader');
    expect(rows[0]?.index).toBe(0);

    const ks = await getKillSwitch(db);
    expect(ks?.id).toBe(1);
  });

  test('the kill switch is a singleton: a second row is rejected', async () => {
    await expect(
      db.query(`INSERT INTO kill_switch (id, active) VALUES (2, false)`),
    ).rejects.toThrow();
    await expect(
      db.query(`INSERT INTO kill_switch (id, active) VALUES (1, true)`),
    ).rejects.toThrow();
  });

  test('attestations are unique per (agent_id, round_id)', async () => {
    await expect(
      insertAttestation(db, {
        agent_id: '00000000-0000-0000-0000-0000000000a1',
        round_id: '00000000-0000-0000-0000-0000000000b1',
        value: 1,
      }),
    ).rejects.toThrow();
  });

  test('a foreign key to a non-existent parent is rejected', async () => {
    await expect(
      insertIntent(db, {
        round_id: randomUUID(),
        agent_id: randomUUID(),
        intent_hash: '0xnope',
        action: 'open',
      }),
    ).rejects.toThrow();
  });

  test('an out-of-domain enum value is rejected', async () => {
    const round = await insertRound(db, { index: 100 });
    await expect(
      db.query(
        `INSERT INTO policy_events (intent_id, agent_id, round_id, rule_fired, decision, severity)
         VALUES ($1, $2, $3, 'x', 'MAYBE', 'none')`,
        ['00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', round.id],
      ),
    ).rejects.toThrow();
  });

  test('a NULL in a NOT NULL column is rejected', async () => {
    await expect(
      db.query(
        `INSERT INTO agents (display_name, owner, strategy_kind) VALUES (NULL, 'o', 'seed')`,
      ),
    ).rejects.toThrow();
  });

  test('target_address is allowed only on a transfer (check constraint)', async () => {
    const round = await insertRound(db, { index: 101 });
    // non-transfer with a target_address → rejected
    await expect(
      insertIntent(db, {
        round_id: round.id,
        agent_id: '00000000-0000-0000-0000-0000000000a1',
        intent_hash: '0xbad',
        action: 'open',
        target_address: '0xattacker',
      }),
    ).rejects.toThrow();
    // transfer with a target_address → allowed
    const ok = await insertIntent(db, {
      round_id: round.id,
      agent_id: '00000000-0000-0000-0000-0000000000a1',
      intent_hash: '0xdrain',
      action: 'transfer',
      target_address: '0xattacker',
    });
    expect(ok.action).toBe('transfer');
  });

  test('numeric/range guards: score>100, decimals>255, int128 overflow, negative CaR', async () => {
    const round = await insertRound(db, { index: 102 });
    const agent = '00000000-0000-0000-0000-0000000000a1';

    await expect(
      db.query(`INSERT INTO agents (display_name, owner, strategy_kind, score_current)
                VALUES ('x','o','seed', 101)`),
    ).rejects.toThrow();

    await expect(
      db.query(
        `INSERT INTO attestations (agent_id, round_id, value, value_decimals) VALUES ($1,$2,1,256)`,
        [agent, round.id],
      ),
    ).rejects.toThrow();

    await expect(
      insertAttestation(db, {
        agent_id: agent,
        round_id: round.id,
        value: 170141183460469231731687303715884105728n, // int128 max + 1
      }),
    ).rejects.toThrow();

    await expect(
      db.query(`INSERT INTO outcomes (agent_id, round_id, capital_at_risk) VALUES ($1,$2,-1)`, [
        agent,
        round.id,
      ]),
    ).rejects.toThrow();
  });

  test('deleting a parent that still has children is rejected (RESTRICT)', async () => {
    await expect(
      db.query(`DELETE FROM agents WHERE id = '00000000-0000-0000-0000-0000000000a1'`),
    ).rejects.toThrow();
  });

  test('resetData empties every table but leaves the schema intact', async () => {
    await resetData(db);
    const { rows } = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM agents`);
    expect(rows[0]?.n).toBe('0');
    // re-seeding after a reset works (idempotent path)
    await seedSmoke(db);
    const board = await listAgentsByScore(db, 10);
    expect(board.length).toBe(1);
  });

  test('insertAgent round-trips through the repo with typed output', async () => {
    const a = await insertAgent(db, {
      display_name: 'roundtrip',
      owner: 'ops',
      strategy_kind: 'external',
      score_current: '12.345',
    });
    expect(a.score_current).toBe('12.345');
    expect(a.status).toBe('active');
    expect(a.created_at).toBeInstanceOf(Date);
  });
});
