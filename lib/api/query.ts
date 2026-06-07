import { CHAIN_STATE, type ChainState } from '../db/schema';
import { type Cursor, decodeCursor } from './cursor';
import { BadRequestError } from './errors';

/**
 * Query-parameter validation for the read endpoints.
 *
 * Every value here is untrusted input straight off the wire. Each parser maps
 * its raw string to a typed, range-checked value or throws a
 * {@link BadRequestError} — there is no third, ambiguous outcome. The data layer
 * already binds every value as a `$n` parameter (never string-concatenated), so
 * these parsers are about *shape and range* (a hostile string can never reach
 * SQL unparameterized); they reject it early with a deterministic 400 instead.
 */

/** Default page size when `limit` is omitted. */
export const DEFAULT_LIMIT = 50;
/** Hard cap; a larger requested `limit` is clamped, not rejected. */
export const MAX_LIMIT = 200;

/**
 * Parse `?limit=`: a base-10 non-negative integer in `[1, MAX_LIMIT]`. Omitted →
 * {@link DEFAULT_LIMIT}. A value above the cap is clamped to {@link MAX_LIMIT}
 * (an unbounded read is a footgun, not a feature). A negative, zero, fractional,
 * or non-numeric value is a {@link BadRequestError}. The strict `^\d+$` test
 * rejects `'-1'`, `'1e9'`, `'0x10'`, `' 5'`, `'5.0'`, and unicode digits.
 */
export function parseLimit(raw: string | null): number {
  if (raw === null || raw === '') return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestError('limit must be a positive integer', 'invalid_limit');
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new BadRequestError('limit must be a positive integer', 'invalid_limit');
  }
  return Math.min(n, MAX_LIMIT);
}

/** Parse the optional `?cursor=` keyset token, or `null` when absent. */
export function parseCursor(raw: string | null): Cursor | null {
  if (raw === null || raw === '') return null;
  return decodeCursor(raw);
}

/** Parse the optional `?chain_state=` filter; `undefined` when absent. */
export function parseChainState(raw: string | null): ChainState | undefined {
  if (raw === null || raw === '') return undefined;
  if ((CHAIN_STATE as readonly string[]).includes(raw)) {
    return raw as ChainState;
  }
  throw new BadRequestError(
    `chain_state must be one of: ${CHAIN_STATE.join(', ')}`,
    'invalid_chain_state',
  );
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Validate a path `id` as a uuid. A malformed id is the *caller's* mistake
 * (400, `invalid_id`); it is distinct from a well-formed id that matches no row,
 * which the handler reports as 404. Keeping the two apart means a probe of
 * random ids never masquerades as "not found".
 */
export function parseUuid(raw: string): string {
  if (!UUID_RE.test(raw)) {
    throw new BadRequestError('id must be a uuid', 'invalid_id');
  }
  return raw;
}
