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

/** Normalize a numeric input to the canonical string the driver expects. */
export function num(value: NumericInput): string {
  return typeof value === 'string' ? value : value.toString();
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
