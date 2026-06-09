import { NextResponse } from 'next/server';

import { encodeCursor } from './cursor';
import { BadRequestError, classifyError } from './errors';

/**
 * Response helpers shared by every read route: a uniform JSON envelope, the
 * cache headers the SWR data layer needs, and the one place an unexpected throw
 * is turned into a safe HTTP error.
 *
 * Cache policy: `no-store`. The screens poll on a fixed `ui_poll_ms` cadence and
 * the `policy_events` feed is a near-real-time red-alert channel, so a cached or
 * shared-cache copy would show stale REJECT/HALT state. The bodies carry no
 * per-user private data, so the concern is freshness, not privacy — but
 * `no-store` covers both.
 */

const CACHE_HEADERS = { 'Cache-Control': 'no-store' } as const;

/** A 200 JSON response with the no-store cache policy. */
export function ok<T>(data: T): NextResponse {
  return NextResponse.json(data, { headers: CACHE_HEADERS });
}

/** A 204 No Content response (used by the operator session login/logout). */
export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CACHE_HEADERS });
}

/**
 * Parse a request's JSON body, mapping a malformed/empty body to a 400 rather
 * than letting the `SyntaxError` collapse to a generic 500. The result is
 * `unknown`: the caller validates the shape (e.g. with a zod schema).
 */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BadRequestError('Request body must be valid JSON', 'invalid_json');
  }
}

/** A keyset-paginated envelope: the page plus the cursor for the next page. */
export interface Page<T> {
  readonly data: T[];
  /** Opaque cursor for the following page, or `null` when the page is the last. */
  readonly next_cursor: string | null;
}

/**
 * Build a {@link Page} from the rows a keyset query returned and their DTOs.
 *
 * `next_cursor` is non-null only when the page is *full* (`rows.length === limit`),
 * which is the sole signal that more rows may exist — a short page is terminal.
 * The cursor pins the last row's `(cursor_t, id)`, the same keyset the query
 * orders by, so the next page continues without gap or overlap.
 *
 * The timestamp comes from the row's `cursor_t` — the microsecond-precise string
 * the page query selects (see `CURSOR_KEY_SQL`) — never from `created_at`: the
 * Neon driver truncates `timestamptz` to milliseconds when it builds the JS
 * `Date`, so a cursor minted from `created_at.toISOString()` would skip rows in
 * the same millisecond but with finer microseconds on the next page.
 */
export function paginate<TRow extends { cursor_t: string; id: string }, TDto>(
  rows: readonly TRow[],
  toDto: (row: TRow) => TDto,
  limit: number,
): Page<TDto> {
  const data = rows.map(toDto);
  const last = rows[rows.length - 1];
  const next_cursor =
    rows.length === limit && last !== undefined
      ? encodeCursor({ t: last.cursor_t, id: last.id })
      : null;
  return { data, next_cursor };
}

/**
 * Run a route handler body and convert any throw into a safe HTTP response.
 *
 * Expected client errors (`ApiError`) carry their own status/message; anything
 * else is collapsed by {@link classifyError} to a generic `503` (dependency
 * down) or `500` so an internal detail never reaches the client. Errors are
 * `no-store` too, so a transient failure is never cached by SWR or a proxy.
 */
export async function route(handler: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await handler();
  } catch (err) {
    const { status, body } = classifyError(err);
    return NextResponse.json(body, { status, headers: CACHE_HEADERS });
  }
}
