import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  applyMigration,
  assertSessionConnection,
  loadMigrations,
  type Migration,
  planDown,
  planUp,
} from '@/lib/db/migrate';
import type { Queryable } from '@/lib/db/types';

const M = (version: string, name = `m${version}`): Migration => ({
  version,
  name,
  up: `-- up ${version}`,
  down: `-- down ${version}`,
});

const ALL = [M('0001'), M('0002'), M('0003')];

/** A fake that records SQL calls and can be told to fail on a given substring. */
class RecordingDb implements Queryable {
  public readonly calls: { sql: string; params?: readonly unknown[] }[] = [];
  constructor(private readonly failOn?: string) {}
  async query<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    this.calls.push(params === undefined ? { sql } : { sql, params });
    if (this.failOn !== undefined && sql.includes(this.failOn)) {
      throw new Error(`boom: ${this.failOn}`);
    }
    return { rows: [], rowCount: 0 };
  }
}

describe('planUp', () => {
  test('returns only unapplied migrations, in ascending order', () => {
    expect(planUp(ALL, new Set(['0001'])).map((m) => m.version)).toEqual(['0002', '0003']);
  });

  test('respects an inclusive upper bound', () => {
    expect(planUp(ALL, new Set(), '0002').map((m) => m.version)).toEqual(['0001', '0002']);
  });

  test('is a no-op when everything is applied', () => {
    expect(planUp(ALL, new Set(['0001', '0002', '0003']))).toEqual([]);
  });

  test('orders numerically, not lexically (10 after 2)', () => {
    const set = [M('0002'), M('0010'), M('0001')];
    expect(planUp(set, new Set()).map((m) => m.version)).toEqual(['0001', '0002', '0010']);
  });
});

describe('planDown', () => {
  const applied = new Set(['0001', '0002', '0003']);

  test('defaults to reverting the single most-recent migration', () => {
    expect(planDown(ALL, applied).map((m) => m.version)).toEqual(['0003']);
  });

  test('reverts N steps, newest first', () => {
    expect(planDown(ALL, applied, { steps: 2 }).map((m) => m.version)).toEqual(['0003', '0002']);
  });

  test('with `to`, reverts everything strictly above the target', () => {
    expect(planDown(ALL, applied, { to: '0001' }).map((m) => m.version)).toEqual(['0003', '0002']);
  });

  test('with to=0, reverts all applied', () => {
    expect(planDown(ALL, applied, { to: '0' }).map((m) => m.version)).toEqual([
      '0003',
      '0002',
      '0001',
    ]);
  });

  test('ignores unapplied migrations', () => {
    expect(planDown(ALL, new Set(['0001'])).map((m) => m.version)).toEqual(['0001']);
  });
});

describe('applyMigration', () => {
  test('up runs in a transaction and records the ledger row', async () => {
    const db = new RecordingDb();
    await applyMigration(db, M('0001'), 'up');
    expect(db.calls.map((c) => c.sql)).toEqual([
      'BEGIN',
      '-- up 0001',
      'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
      'COMMIT',
    ]);
    expect(db.calls[2]?.params).toEqual(['0001', 'm0001']);
  });

  test('down runs the down SQL and deletes the ledger row', async () => {
    const db = new RecordingDb();
    await applyMigration(db, M('0002'), 'down');
    expect(db.calls.map((c) => c.sql)).toEqual([
      'BEGIN',
      '-- down 0002',
      'DELETE FROM schema_migrations WHERE version = $1',
      'COMMIT',
    ]);
    expect(db.calls[2]?.params).toEqual(['0002']);
  });

  test('rolls back and rethrows when the migration SQL fails', async () => {
    const db = new RecordingDb('-- up 0001');
    await expect(applyMigration(db, M('0001'), 'up')).rejects.toThrow('boom');
    expect(db.calls.map((c) => c.sql)).toEqual(['BEGIN', '-- up 0001', 'ROLLBACK']);
  });

  test('a failing ROLLBACK does not mask the original migration error', async () => {
    // Fail on both the migration SQL and the ROLLBACK; the caller must still see
    // the root cause, not the rollback error.
    class DoubleFailDb implements Queryable {
      async query<R = Record<string, unknown>>(
        sql: string,
      ): Promise<{ rows: R[]; rowCount: number | null }> {
        if (sql.includes('-- up 0001')) throw new Error('boom: migration');
        if (sql === 'ROLLBACK') throw new Error('boom: rollback');
        return { rows: [], rowCount: 0 };
      }
    }
    await expect(applyMigration(new DoubleFailDb(), M('0001'), 'up')).rejects.toThrow(
      'boom: migration',
    );
  });
});

describe('loadMigrations', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vec-mig-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('throws on a duplicate version+direction instead of silently picking one', () => {
    writeFileSync(join(dir, '0001_a.up.sql'), '-- a');
    writeFileSync(join(dir, '0001_a.down.sql'), '-- a down');
    writeFileSync(join(dir, '0001_b.up.sql'), '-- b'); // duplicate up for version 0001
    expect(() => loadMigrations(dir)).toThrow(/duplicate up migration for version 0001/);
  });
});

describe('assertSessionConnection', () => {
  /** Fake that echoes a set_config value back on current_setting (a real session). */
  class SessionDb implements Queryable {
    private settings = new Map<string, string>();
    async query<R = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<{ rows: R[]; rowCount: number | null }> {
      if (sql.includes('set_config')) {
        this.settings.set(String(params?.[0]), String(params?.[1]));
        return { rows: [], rowCount: 0 };
      }
      const v = this.settings.get(String(params?.[0])) ?? '';
      return { rows: [{ v } as R], rowCount: 1 };
    }
  }

  /** Fake that drops session state between statements (transaction pooler). */
  class PoolerDb implements Queryable {
    async query<R = Record<string, unknown>>(
      sql: string,
    ): Promise<{ rows: R[]; rowCount: number | null }> {
      if (sql.includes('set_config')) return { rows: [], rowCount: 0 };
      return { rows: [{ v: '' } as R], rowCount: 1 };
    }
  }

  test('resolves when session state persists across statements', async () => {
    await expect(assertSessionConnection(new SessionDb())).resolves.toBeUndefined();
  });

  test('throws when session state is lost (transaction pooling)', async () => {
    await expect(assertSessionConnection(new PoolerDb())).rejects.toThrow(/session/i);
  });
});
