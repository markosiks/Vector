import type { z } from 'zod';

import { buildInsert } from '../sql';
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

/** Insert one row and return it parsed through `schema`. */
export async function insertOne<S extends z.ZodTypeAny>(
  db: Queryable,
  table: string,
  values: Record<string, unknown>,
  schema: S,
): Promise<z.infer<S>> {
  const { text, params } = buildInsert(table, values);
  const { rows } = await db.query(text, params);
  if (rows.length === 0) {
    throw new Error(`insert into ${table} returned no row`);
  }
  return schema.parse(rows[0]);
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
