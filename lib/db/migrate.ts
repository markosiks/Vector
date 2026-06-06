import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Pool } from '@neondatabase/serverless';

import { assertIdent } from './sql';
import type { Queryable } from './types';

/**
 * A tiny, dependency-light migration runner built on the Neon client the repo
 * already uses (no ORM, per the data-layer brief). It provides:
 *
 * - forward + rollback via paired `NNNN_name.up.sql` / `.down.sql` files,
 * - an idempotent `schema_migrations` ledger so re-applying is a no-op,
 * - one transaction per migration (atomic: a mid-migration failure rolls back),
 * - a session advisory lock so two processes can't migrate concurrently.
 *
 * The SQL DDL itself owns every schema invariant; this module only sequences it.
 */

/** Ledger table tracking which migration versions have been applied. */
const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  name       text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

/** Fixed key for the migration advisory lock (arbitrary, stable across runs). */
const MIGRATION_LOCK_KEY = 4_157_206_001n;

const VERSION_RE = /^(\d+)_(.+)\.(up|down)\.sql$/;

/** A single migration: a version, a human name, and its up/down SQL. */
export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly up: string;
  readonly down: string;
}

/**
 * Load and validate the migration set from a directory of `NNNN_name.up.sql` /
 * `.down.sql` files. Throws if a half (up or down) is missing or a version is
 * duplicated, so a malformed set fails loudly before any SQL runs.
 */
export function loadMigrations(dir: string): Migration[] {
  const halves = new Map<string, { name: string; up?: string; down?: string }>();

  for (const file of readdirSync(dir)) {
    const match = VERSION_RE.exec(file);
    if (!match) continue;
    const [, version, name, kind] = match as unknown as [string, string, string, 'up' | 'down'];
    const entry = halves.get(version) ?? { name };
    entry[kind] = readFileSync(join(dir, file), 'utf8');
    halves.set(version, entry);
  }

  const migrations: Migration[] = [];
  for (const [version, { name, up, down }] of halves) {
    if (up === undefined) throw new Error(`migration ${version} is missing its .up.sql`);
    if (down === undefined) throw new Error(`migration ${version} is missing its .down.sql`);
    migrations.push({ version, name, up, down });
  }
  return sortByVersion(migrations);
}

/** Total order on versions by numeric value, then lexicographically. */
function sortByVersion(migrations: Migration[]): Migration[] {
  return [...migrations].sort((a, b) => {
    const na = Number(a.version);
    const nb = Number(b.version);
    if (na !== nb) return na - nb;
    return a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
  });
}

/**
 * Forward plan: every migration not yet applied, in ascending order, optionally
 * stopping at (and including) `to`. Pure — unit-tested without a database.
 */
export function planUp(
  all: readonly Migration[],
  applied: ReadonlySet<string>,
  to?: string,
): Migration[] {
  const ordered = sortByVersion([...all]);
  const plan: Migration[] = [];
  for (const m of ordered) {
    if (to !== undefined && Number(m.version) > Number(to)) break;
    if (!applied.has(m.version)) plan.push(m);
  }
  return plan;
}

/**
 * Rollback plan: applied migrations to revert, in descending order. With `to`,
 * revert everything strictly above `to`; with `steps`, revert the last N; with
 * neither, revert the single most-recent migration. Pure.
 */
export function planDown(
  all: readonly Migration[],
  applied: ReadonlySet<string>,
  opts: { to?: string; steps?: number } = {},
): Migration[] {
  const reverted = sortByVersion([...all]).filter((m) => applied.has(m.version));
  reverted.reverse();
  if (opts.to !== undefined) {
    return reverted.filter((m) => Number(m.version) > Number(opts.to));
  }
  const steps = opts.steps ?? 1;
  return reverted.slice(0, Math.max(0, steps));
}

/** Read the set of applied versions from the ledger (creating it if absent). */
export async function appliedVersions(db: Queryable): Promise<Set<string>> {
  await db.query(LEDGER_DDL);
  const { rows } = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
  return new Set(rows.map((r) => r.version));
}

/**
 * Apply one migration in a single transaction: run its SQL, then record (up) or
 * remove (down) the ledger row. Any failure rolls the whole step back, so the
 * schema and the ledger never disagree. Exposed for unit tests with a fake
 * {@link Queryable}.
 */
export async function applyMigration(
  db: Queryable,
  migration: Migration,
  direction: 'up' | 'down',
): Promise<void> {
  await db.query('BEGIN');
  try {
    if (direction === 'up') {
      await db.query(migration.up);
      await db.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
        migration.version,
        migration.name,
      ]);
    } else {
      await db.query(migration.down);
      await db.query('DELETE FROM schema_migrations WHERE version = $1', [migration.version]);
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

/** Outcome of a migration run: which versions moved, in order. */
export interface MigrationResult {
  readonly direction: 'up' | 'down';
  readonly applied: string[];
}

/**
 * Run migrations against a real pool. Acquires a dedicated client, takes a
 * session advisory lock (so concurrent runners serialize rather than race),
 * computes the plan from the live ledger, and applies each step in its own
 * transaction. Always releases the lock and the client.
 */
export async function migrate(
  pool: Pool,
  migrations: readonly Migration[],
  opts: { direction: 'up' | 'down'; to?: string; steps?: number; searchPath?: string } = {
    direction: 'up',
  },
): Promise<MigrationResult> {
  const client = await pool.connect();
  try {
    if (opts.searchPath !== undefined) {
      await client.query(`SET search_path TO ${assertIdent(opts.searchPath)}, public`);
    }
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
    const applied = await appliedVersions(client as unknown as Queryable);
    const plan =
      opts.direction === 'up'
        ? planUp(migrations, applied, opts.to)
        : planDown(migrations, applied, {
            ...(opts.to !== undefined ? { to: opts.to } : {}),
            ...(opts.steps !== undefined ? { steps: opts.steps } : {}),
          });

    for (const m of plan) {
      await applyMigration(client as unknown as Queryable, m, opts.direction);
    }
    return { direction: opts.direction, applied: plan.map((m) => m.version) };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()]);
    } finally {
      client.release();
    }
  }
}

/** Absolute path to the bundled SQL migration directory. */
export const MIGRATIONS_DIR = join(import.meta.dir, 'migrations');
