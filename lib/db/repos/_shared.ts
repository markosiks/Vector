import type { z } from 'zod';

import { buildInsert, type InsertOptions } from '../sql';
import type { Queryable } from '../types';

/**
 * Shared primitives for the repository layer. Repos stay thin: build a
 * parameterized statement, run it on the injected {@link Queryable}, and parse
 * the returned row with its zod schema so callers always get a validated,
 * typed row (or a deterministic error).
 */

/** A `numeric` bind value. Accepts a string/number/bigint, stores as string to keep precision. */
export type NumericInput = string | number | bigint;

/**
 * Normalize a numeric input to the canonical decimal string the driver binds
 * into a `numeric` column.
 *
 * A JS `number` is only accepted when it is an exactly-representable safe
 * integer. A non-integer (`0.1 + 0.2` → `0.30000000000000004`) or an integer
 * past `Number.MAX_SAFE_INTEGER` (e.g. an int128 `attestations.value` or a
 * `bigint` block number passed as a `number`) has already lost precision before
 * this function runs, so coercing it would silently persist a corrupted
 * money/score/on-chain value — violating the "numeric is exact, never through a
 * float" invariant. Such inputs throw; callers pass an exact `string` (or
 * `bigint`) instead.
 */
export function num(value: NumericInput): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `num(): ${value} is not an exactly-representable integer; ` +
        'pass a string for non-integer or large numeric values',
    );
  }
  return value.toString();
}

/**
 * Insert one row and return it parsed through `schema`, or `null` when the
 * statement returned no row — which, with `options.onConflictDoNothing`, means a
 * conflicting row already existed (an idempotent reservation lost the race).
 */
export async function insertOneOrNull<S extends z.ZodTypeAny>(
  db: Queryable,
  table: string,
  values: Record<string, unknown>,
  schema: S,
  options?: InsertOptions,
): Promise<z.infer<S> | null> {
  const { text, params } = buildInsert(table, values, options);
  const { rows } = await db.query(text, params);
  const first = rows[0];
  return first === undefined ? null : schema.parse(first);
}

/** Insert one row and return it parsed through `schema`. Throws if no row is returned. */
export async function insertOne<S extends z.ZodTypeAny>(
  db: Queryable,
  table: string,
  values: Record<string, unknown>,
  schema: S,
): Promise<z.infer<S>> {
  const row = await insertOneOrNull(db, table, values, schema);
  if (row === null) {
    throw new Error(`insert into ${table} returned no row`);
  }
  return row;
}

/** Run a parameterized query and parse each row through `schema`. */
export async function selectMany<S extends z.ZodTypeAny>(
  db: Queryable,
  sql: string,
  params: readonly unknown[],
  schema: S,
): Promise<z.infer<S>[]> {
  const { rows } = await db.query(sql, params);
  return rows.map((r) => schema.parse(r));
}

/** A keyset position for the time-ordered feeds: the last row's `(created_at, id)`. */
export interface Keyset {
  readonly t: string;
  readonly id: string;
}

/**
 * SQL expression yielding a **microsecond-precision**, lexicographically-sortable
 * ISO-8601 UTC string for `created_at`, aliased `cursor_t`.
 *
 * The cursor key must come from this, NOT from the row's JS `Date`: the Neon
 * driver truncates `timestamptz` to millisecond resolution when it builds a
 * `Date`, and `Date.toISOString()` emits only 3 fractional digits. A cursor
 * built that way (`…123Z` for a stored `…123456+00`) makes the seek predicate
 * `created_at < $t` silently skip rows in the same millisecond whose
 * microseconds fall below the truncated value — real row loss across a page
 * boundary in the audit feeds. Selecting the key at full precision in SQL and
 * binding it straight back as `::timestamptz` keeps the comparison exact.
 */
export const CURSOR_KEY_SQL =
  `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_t`;

/**
 * Append a keyset (seek) predicate for a feed ordered `created_at DESC, id DESC`
 * and return the SQL fragment, binding `before` into `params` as `$n`
 * parameters (never inlined). The fragment selects rows strictly *older* than
 * the cursor — `created_at < t OR (created_at = t AND id < id)` — so paging is
 * stable while new rows arrive at the head. The timestamp is bound once and
 * referenced twice; both binds are cast (`::timestamptz`, `::uuid`) so Postgres
 * never has to infer a parameter's type from context.
 */
export function keysetBefore(before: Keyset, params: unknown[]): string {
  params.push(before.t);
  const t = `$${params.length}::timestamptz`;
  params.push(before.id);
  const id = `$${params.length}::uuid`;
  return `(created_at < ${t} OR (created_at = ${t} AND id < ${id}))`;
}

/** Run a parameterized query and parse the first row, or return `null`. */
export async function selectOne<S extends z.ZodTypeAny>(
  db: Queryable,
  sql: string,
  params: readonly unknown[],
  schema: S,
): Promise<z.infer<S> | null> {
  const { rows } = await db.query(sql, params);
  const first = rows[0];
  return first === undefined ? null : schema.parse(first);
}
