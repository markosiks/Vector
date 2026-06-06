import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from '@neondatabase/serverless';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { loadMigrations, migrate, MIGRATIONS_DIR } from '@/lib/db/migrate';
import { insertAgent } from '@/lib/db/repos/agents';
import { getIntent, insertIntent } from '@/lib/db/repos/intents';
import { insertRound } from '@/lib/db/repos/rounds';
import type { Queryable } from '@/lib/db/types';
import { signIntent } from '@/lib/intent/sign';
import { validateIntent } from '@/lib/intent/validate';
import { TEST_PK, TEST_SIGNER, validOpenInput } from '@/tests/fixtures/intent-fixtures';

/**
 * Integration: the full Intent path — build → sign → validate → persist to the
 * P0.2 `intents` table → read back → confirm the stored `intent_hash` matches.
 * Isolated in a throwaway schema; skipped unless `DATABASE_URL` is set.
 */

const hasDb = typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0;
const describeDb = hasDb ? describe : describe.skip;

describeDb('Intent → intents persistence (isolated schema on real Neon)', () => {
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

  test('a validated intent persists with a matching intent_hash and reads back identically', async () => {
    const agent = await insertAgent(db, {
      display_name: 'Seed',
      owner: 'vector',
      strategy_kind: 'seed',
    });
    const round = await insertRound(db, { index: 1, state: 'open' });

    const signed = await signIntent(
      validOpenInput({ agent_id: agent.id, ttl: new Date(Date.now() + 3_600_000).toISOString() }),
      TEST_PK,
    );
    const result = await validateIntent(signed, { resolveSigner: () => TEST_SIGNER });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stored = await insertIntent(db, {
      round_id: round.id,
      agent_id: agent.id,
      intent_hash: result.intent_hash,
      action: result.intent.action,
      market: 'market' in result.intent ? result.intent.market : null,
      side: 'side' in result.intent ? result.intent.side : null,
      size: result.intent.size,
      leverage: 'leverage' in result.intent ? result.intent.leverage : null,
      max_slippage: 'max_slippage' in result.intent ? result.intent.max_slippage : null,
      nonce: result.intent.nonce,
      ttl: new Date(result.intent.ttl),
      signature: result.intent.signature,
      raw_json: result.intent,
    });

    const readBack = await getIntent(db, stored.id);
    expect(readBack).not.toBeNull();
    expect(readBack?.intent_hash).toBe(result.intent_hash);
    expect(readBack?.size).toBe('1000.000000000000000000');
    expect(readBack?.action).toBe('open');
  });

  test('the DB CHECK backstops target_address-only-on-transfer', async () => {
    const agent = await insertAgent(db, {
      display_name: 'Seed2',
      owner: 'vector',
      strategy_kind: 'seed',
    });
    const round = await insertRound(db, { index: 2, state: 'open' });
    await expect(
      insertIntent(db, {
        round_id: round.id,
        agent_id: agent.id,
        intent_hash: '0x' + 'a'.repeat(64),
        action: 'open',
        market: 'BTC-PERP',
        target_address: '0xdead', // illegal on a non-transfer
      }),
    ).rejects.toThrow();
  });
});
