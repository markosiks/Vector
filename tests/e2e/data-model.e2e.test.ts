import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from '@neondatabase/serverless';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  appliedVersions,
  applyMigration,
  loadMigrations,
  migrate,
  MIGRATIONS_DIR,
  type Migration,
} from '@/lib/db/migrate';
import type { Queryable } from '@/lib/db/types';

/**
 * Hard end-to-end tests for the migration machinery against a **real** Neon DB.
 * Each test runs in its own throwaway schema. Skipped unless `DATABASE_URL` set:
 *
 *   DATABASE_URL='postgresql://…' bun run test:e2e
 *
 * Covered: idempotent re-apply, full down→up integrity, atomic rollback on a
 * mid-migration failure, and serialization of two concurrent migrators (the
 * advisory lock must prevent a "type already exists" race).
 */

const hasDb = typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0;
const describeDb = hasDb ? describe : describe.skip;

describeDb('migration runner (hard e2e on real Neon)', () => {
  let pool: Pool;
  let migrations: Migration[];

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    migrations = loadMigrations(MIGRATIONS_DIR);
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Create an empty schema; return its name and an open inspection client. */
  async function freshSchema(): Promise<{ schema: string; client: PoolClient }> {
    const schema = `vec_e2e_${randomUUID().replace(/-/g, '')}`;
    const client = await pool.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    return { schema, client };
  }

  async function drop(schema: string, client: PoolClient): Promise<void> {
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      client.release();
    }
  }

  test('migrate up is idempotent: a second run applies nothing', async () => {
    const { schema, client } = await freshSchema();
    try {
      const first = await migrate(pool, migrations, { direction: 'up', searchPath: schema });
      const second = await migrate(pool, migrations, { direction: 'up', searchPath: schema });
      expect(first.applied).toEqual(migrations.map((m) => m.version));
      expect(second.applied).toEqual([]);
    } finally {
      await drop(schema, client);
    }
  });

  test('full down→up cycle preserves integrity', async () => {
    const { schema, client } = await freshSchema();
    try {
      await migrate(pool, migrations, { direction: 'up', searchPath: schema });
      await migrate(pool, migrations, { direction: 'down', to: '0', searchPath: schema });

      const gone = await client.query<{ reg: string | null }>(`SELECT to_regclass($1) AS reg`, [
        `${schema}.agents`,
      ]);
      expect(gone.rows[0]?.reg).toBeNull();

      const up2 = await migrate(pool, migrations, { direction: 'up', searchPath: schema });
      expect(up2.applied).toEqual(migrations.map((m) => m.version));
      const back = await client.query<{ reg: string | null }>(`SELECT to_regclass($1) AS reg`, [
        `${schema}.agents`,
      ]);
      expect(back.rows[0]?.reg).not.toBeNull();
    } finally {
      await drop(schema, client);
    }
  });

  test('a failure mid-migration rolls back atomically (no partial state, no ledger row)', async () => {
    const { schema, client } = await freshSchema();
    try {
      const db = client as unknown as Queryable;
      await appliedVersions(db); // materialize the ledger in this schema

      const bad: Migration = {
        version: '9999',
        name: 'intentionally_broken',
        up: 'CREATE TABLE atomic_probe (x int); SELECT 1 / 0;',
        down: 'DROP TABLE IF EXISTS atomic_probe;',
      };

      await expect(applyMigration(db, bad, 'up')).rejects.toThrow();

      const probe = await client.query<{ reg: string | null }>(`SELECT to_regclass($1) AS reg`, [
        `${schema}.atomic_probe`,
      ]);
      expect(probe.rows[0]?.reg).toBeNull();

      const applied = await appliedVersions(db);
      expect(applied.has('9999')).toBe(false);
    } finally {
      await drop(schema, client);
    }
  });

  test('two concurrent migrators serialize via the advisory lock (no race error)', async () => {
    const { schema, client } = await freshSchema();
    try {
      const [a, b] = await Promise.all([
        migrate(pool, migrations, { direction: 'up', searchPath: schema }),
        migrate(pool, migrations, { direction: 'up', searchPath: schema }),
      ]);

      // Exactly one runner applied the full set; the other found it already done.
      const applied = [a.applied, b.applied].sort((x, y) => x.length - y.length);
      expect(applied[0]).toEqual([]);
      expect(applied[1]).toEqual(migrations.map((m) => m.version));

      // And no version was recorded twice.
      const { rows } = await client.query<{ version: string; n: string }>(
        `SELECT version, count(*)::text AS n FROM schema_migrations GROUP BY version`,
      );
      for (const r of rows) {
        expect(r.n).toBe('1');
      }
    } finally {
      await drop(schema, client);
    }
  });
});
