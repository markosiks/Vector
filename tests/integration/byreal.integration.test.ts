import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from '@neondatabase/serverless';
import { afterAll, describe, expect, test } from 'bun:test';

import { loadMigrations, migrate, MIGRATIONS_DIR } from '@/lib/db/migrate';
import type { Queryable } from '@/lib/db/types';
import { runArc } from '@/lib/replay';
import { createByrealRail } from '@/lib/rail/byreal/adapter';
import type { ByrealCliResult } from '@/lib/rail/byreal/cli';
import type { ByrealCliRunner } from '@/lib/rail/byreal/adapter';
import { buildDemoArc } from '@/seed';

/**
 * Integration: the Byreal credibility rail wired into the live spine (P2.1),
 * against a real Neon database in throwaway schemas. The load-bearing claim is
 * the §3 determinism boundary: enabling the live rail writes real
 * `executions/outcomes(rail='byreal')` rows *without changing the scores*, and a
 * failing rail degrades silently to the seeded settlement. Skipped unless
 * `DATABASE_URL` is set.
 */

const hasDb = typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0;
const describeDb = hasDb ? describe : describe.skip;

/** A mocked CLI runner: every order fills; every position read returns a book. */
function fillingRunner(): ByrealCliRunner {
  return async (subArgv) => {
    const isPosition = subArgv[0] === 'position' && subArgv[1] === 'list';
    const data = isPosition
      ? [{ coin: 'BTC', positionValue: '650', unrealizedPnl: '12', szi: '0.01' }]
      : { filled: { oid: Math.floor(Math.random() * 1e9), totalSz: '0.01', avgPx: '65000' }, fee: '0.5' };
    return { stdout: JSON.stringify({ success: true, data }), stderr: '', code: 0 } as ByrealCliResult;
  };
}

/** A mocked CLI runner that always errors — exercises the silent seed fallback. */
function failingRunner(): ByrealCliRunner {
  return async () => {
    throw new Error('venue down');
  };
}

interface Harness {
  client: PoolClient;
  db: Queryable;
  count: (sql: string) => Promise<number>;
  scores: () => Promise<string[]>;
  teardown: () => Promise<void>;
}

async function setupSchema(): Promise<Harness> {
  const schema = `vec_test_${randomUUID().replace(/-/g, '')}`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}, public`);
  await migrate(pool, loadMigrations(MIGRATIONS_DIR), { direction: 'up', searchPath: schema });
  const count = async (sql: string): Promise<number> => {
    const { rows } = await client.query(sql);
    return Number((rows[0] as { n: string }).n);
  };
  const scores = async (): Promise<string[]> => {
    const { rows } = await client.query('SELECT value FROM scores ORDER BY value ASC');
    return (rows as { value: string }[]).map((r) => r.value);
  };
  return {
    client,
    db: client as unknown as Queryable,
    count,
    scores,
    teardown: async () => {
      try {
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        client.release();
        await pool.end();
      }
    },
  };
}

describeDb('byreal credibility rail honors the determinism boundary', () => {
  const harnesses: Harness[] = [];
  afterAll(async () => {
    for (const h of harnesses) await h.teardown();
  });

  test('writes byreal rows but leaves scores byte-identical to a seed-only run', async () => {
    const arc = buildDemoArc({ rounds: 2 });

    // Baseline: no credibility rail.
    const base = await setupSchema();
    harnesses.push(base);
    await runArc(base.db, arc);
    const baseScores = await base.scores();
    expect(await base.count("SELECT count(*) n FROM executions WHERE rail = 'byreal'")).toBe(0);

    // With the (mocked) Byreal credibility rail.
    const live = await setupSchema();
    harnesses.push(live);
    const credibilityRail = createByrealRail({
      credentials: { agentKey: 'k', walletAddress: `0x${'a'.repeat(40)}`, network: 'testnet' },
      runCli: fillingRunner(),
    });
    await runArc(live.db, arc, { credibilityRail });

    // Real byreal executions + outcomes were recorded for the credibility surface…
    expect(
      await live.count("SELECT count(*) n FROM executions WHERE rail = 'byreal'"),
    ).toBeGreaterThan(0);
    expect(
      await live.count(
        "SELECT count(*) n FROM outcomes o JOIN executions e ON e.id = o.execution_id WHERE e.rail = 'byreal'",
      ),
    ).toBeGreaterThan(0);
    // …and the seed settlement is still present and unchanged.
    expect(await live.count("SELECT count(*) n FROM executions WHERE rail = 'seed'")).toBeGreaterThan(
      0,
    );
    // The scores are identical — byreal outcomes never fed the deterministic score.
    expect(await live.scores()).toEqual(baseScores);
  });

  test('a failing credibility rail degrades silently to the seed (no byreal rows, scores intact)', async () => {
    const arc = buildDemoArc({ rounds: 2 });

    const base = await setupSchema();
    harnesses.push(base);
    await runArc(base.db, arc);
    const baseScores = await base.scores();

    const live = await setupSchema();
    harnesses.push(live);
    const credibilityRail = createByrealRail({
      credentials: { agentKey: 'k', walletAddress: `0x${'a'.repeat(40)}`, network: 'testnet' },
      runCli: failingRunner(),
    });
    await runArc(live.db, arc, { credibilityRail });

    expect(await live.count("SELECT count(*) n FROM executions WHERE rail = 'byreal'")).toBe(0);
    expect(await live.count("SELECT count(*) n FROM executions WHERE rail = 'seed'")).toBeGreaterThan(
      0,
    );
    expect(await live.scores()).toEqual(baseScores);
  });
});
