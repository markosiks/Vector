import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from '@neondatabase/serverless';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { loadMigrations, migrate, MIGRATIONS_DIR } from '@/lib/db/migrate';
import { insertAgent } from '@/lib/db/repos/agents';
import {
  insertIntent,
  insertIntentReserving,
  isNonceUsed,
  type NewIntent,
} from '@/lib/db/repos/intents';
import { insertRound } from '@/lib/db/repos/rounds';
import type { Queryable } from '@/lib/db/types';

/**
 * Integration: durable anti-replay on `intents (agent_id, nonce)` — the UNIQUE
 * constraint added in migration 0002 and the `insertIntentReserving` /
 * `isNonceUsed` repo primitives that ride on it. Isolated in a throwaway schema;
 * skipped unless `DATABASE_URL` is set.
 */

const hasDb = typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0;
const describeDb = hasDb ? describe : describe.skip;

describeDb('intents anti-replay — UNIQUE(agent_id, nonce) on real Neon', () => {
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

  const newOpen = (agentId: string, roundId: string, nonce: string | null): NewIntent => ({
    round_id: roundId,
    agent_id: agentId,
    intent_hash: '0x' + 'a'.repeat(64),
    action: 'open',
    nonce,
  });

  test('reserving insert wins once; a replayed (agent, nonce) returns null', async () => {
    const agent = await insertAgent(db, { display_name: 'A', owner: 'v', strategy_kind: 'seed' });
    const round = await insertRound(db, { index: 1, state: 'open' });

    const first = await insertIntentReserving(db, newOpen(agent.id, round.id, 'n1'));
    expect(first).not.toBeNull();
    expect(await isNonceUsed(db, agent.id, 'n1')).toBe(true);

    // The replay loses the race deterministically — no duplicate row, no throw.
    expect(await insertIntentReserving(db, newOpen(agent.id, round.id, 'n1'))).toBeNull();

    // A different nonce, or the same nonce under a different agent, is allowed.
    expect(await insertIntentReserving(db, newOpen(agent.id, round.id, 'n2'))).not.toBeNull();
    const agent2 = await insertAgent(db, { display_name: 'B', owner: 'v', strategy_kind: 'seed' });
    expect(await insertIntentReserving(db, newOpen(agent2.id, round.id, 'n1'))).not.toBeNull();
  });

  test('plain insertIntent throws on a duplicate (agent, nonce) — the DB is the backstop', async () => {
    const agent = await insertAgent(db, { display_name: 'C', owner: 'v', strategy_kind: 'seed' });
    const round = await insertRound(db, { index: 2, state: 'open' });

    await insertIntent(db, newOpen(agent.id, round.id, 'dup'));
    await expect(insertIntent(db, newOpen(agent.id, round.id, 'dup'))).rejects.toThrow();
  });

  test('NULL nonces never collide — seed/internal rows are exempt', async () => {
    const agent = await insertAgent(db, { display_name: 'D', owner: 'v', strategy_kind: 'seed' });
    const round = await insertRound(db, { index: 3, state: 'open' });

    expect(await insertIntentReserving(db, newOpen(agent.id, round.id, null))).not.toBeNull();
    expect(await insertIntentReserving(db, newOpen(agent.id, round.id, null))).not.toBeNull();
    expect(await isNonceUsed(db, agent.id, '')).toBe(false);
  });
});
