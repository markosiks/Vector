import { z } from 'zod';

import { BadRequestError } from './errors';

/**
 * Opaque keyset cursor for the time-ordered feeds.
 *
 * The feeds page by `(created_at DESC, id DESC)` — a keyset, not an offset — so
 * pagination is stable while new rows are inserted at the head (a `LIMIT/OFFSET`
 * feed would skip or repeat rows under that write pattern). A cursor pins the
 * last row a page returned; the next page asks for strictly-older keys. It is
 * encoded as base64url so the client treats it as an opaque token and never
 * constructs the SQL predicate itself.
 */

/** The decoded keyset position: the timestamp and id of the last row seen. */
export interface Cursor {
  /** `created_at` of the last row, as an ISO-8601 string. */
  readonly t: string;
  /** `id` (uuid) of the last row — the tie-breaker within one timestamp. */
  readonly id: string;
}

/** Strict shape so a tampered/garbage token is rejected, not silently accepted. */
const cursorSchema = z
  .object({ t: z.string().datetime({ offset: true }), id: z.string().uuid() })
  .strict();

/** Encode a keyset position into an opaque base64url token. */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Decode an opaque cursor token. Any malformed token — bad base64, non-JSON,
 * wrong/extra keys, a non-ISO timestamp, a non-uuid id — is a client error
 * ({@link BadRequestError}, 400), never a 5xx: the value is fully untrusted and
 * must resolve deterministically to a rejection rather than reaching SQL.
 */
export function decodeCursor(token: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestError('Malformed cursor', 'invalid_cursor');
  }
  const result = cursorSchema.safeParse(parsed);
  if (!result.success) {
    throw new BadRequestError('Malformed cursor', 'invalid_cursor');
  }
  return result.data;
}
