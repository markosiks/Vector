/**
 * Small SQL helpers for the repository layer.
 *
 * Values are *always* bound as `$n` parameters — never string-concatenated — so
 * the data layer cannot be SQL-injected. Identifiers (table/column names) come
 * only from our own constants, but are still validated against a strict pattern
 * as defense in depth before being interpolated.
 */

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/** Reject any identifier that isn't a plain snake_case SQL name. */
export function assertIdent(name: string): string {
  if (!IDENT_RE.test(name)) {
    throw new Error(`unsafe SQL identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

/** A parameterized statement: SQL text plus its ordered bind values. */
export interface Statement {
  readonly text: string;
  readonly params: unknown[];
}

/**
 * Build a parameterized `INSERT ... RETURNING *` from a column→value map.
 * Keys present with `undefined` values are omitted (the column keeps its DB
 * default); `null` is passed through as a real SQL NULL.
 */
export function buildInsert(table: string, values: Record<string, unknown>): Statement {
  assertIdent(table);
  const cols: string[] = [];
  const params: unknown[] = [];
  const placeholders: string[] = [];

  for (const [col, value] of Object.entries(values)) {
    if (value === undefined) continue;
    cols.push(assertIdent(col));
    params.push(value);
    placeholders.push(`$${params.length}`);
  }

  if (cols.length === 0) {
    throw new Error(`buildInsert(${table}): no columns to insert`);
  }

  const text = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;
  return { text, params };
}
