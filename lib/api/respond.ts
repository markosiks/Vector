import { NextResponse } from 'next/server';

import { encodeCursor } from './cursor';
import { classifyError } from './errors';

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
 * The cursor pins the last row's `(created_at, id)`, the same keyset the query
 * orders by, so the next page continues without gap or overlap.
 */
export function paginate<TRow extends { created_at: Date; id: string }, TDto>(
  rows: readonly TRow[],
  toDto: (row: TRow) => TDto,
  limit: number,
): Page<TDto> {
  const data = rows.map(toDto);
  const last = rows[rows.length - 1];
  const next_cursor =
    rows.length === limit && last !== undefined
      ? encodeCursor({ t: last.created_at.toISOString(), id: last.id })
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
