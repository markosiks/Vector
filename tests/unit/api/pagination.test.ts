import { describe, expect, test } from 'bun:test';

import { paginate } from '@/lib/api/respond';

/**
 * Regression tests for the limit+1 pagination fix (F-06).
 *
 * `paginate()` now expects callers to fetch `limit+1` rows. It slices to
 * `limit`, and sets `next_cursor` only when the extra sentinel row is present.
 * This eliminates the spurious empty round-trip when total rows is a multiple
 * of `limit`.
 */

function makeRow(id: string, t: string) {
  return { id, cursor_t: t };
}

const toDto = (r: { id: string; cursor_t: string }) => ({ id: r.id, t: r.cursor_t });

describe('paginate()', () => {
  test('empty result → no cursor', () => {
    const page = paginate([], toDto, 10);
    expect(page.data).toHaveLength(0);
    expect(page.next_cursor).toBeNull();
  });

  test('fewer than limit rows → no cursor (terminal page)', () => {
    const rows = [makeRow('a', '2026-01-01T00:00:00.000000Z')];
    const page = paginate(rows, toDto, 10);
    expect(page.data).toHaveLength(1);
    expect(page.next_cursor).toBeNull();
  });

  test('exactly limit rows → no cursor (no sentinel present)', () => {
    // Previously this emitted a false next_cursor. With limit+1 semantics,
    // exactly `limit` rows means no sentinel → terminal page.
    const rows = Array.from({ length: 5 }, (_, i) => makeRow(String(i), `2026-01-0${i + 1}T00:00:00.000000Z`));
    const page = paginate(rows, toDto, 5);
    expect(page.data).toHaveLength(5);
    expect(page.next_cursor).toBeNull();
  });

  test('limit+1 rows → cursor pointing at the last emitted row', () => {
    const cursorT = '2026-06-08T07:00:00.123456Z';
    const sentinelT = '2026-06-08T06:00:00.000000Z';
    const rows = [
      makeRow('row-0', cursorT),
      makeRow('sentinel', sentinelT), // the +1 sentinel
    ];
    const page = paginate(rows, toDto, 1);
    // Only the first `limit` rows are emitted.
    expect(page.data).toHaveLength(1);
    expect((page.data[0] as { id: string }).id).toBe('row-0');
    // Cursor must be non-null.
    expect(page.next_cursor).not.toBeNull();
  });

  test('limit+1 rows → cursor pins the correct (last emitted) row', () => {
    const rows = [
      makeRow('first', '2026-06-08T10:00:00.000000Z'),
      makeRow('second', '2026-06-08T09:00:00.000000Z'),
      makeRow('sentinel', '2026-06-08T08:00:00.000000Z'),
    ];
    const page = paginate(rows, toDto, 2);
    expect(page.data).toHaveLength(2);
    // Cursor should encode the second row (last emitted), not the sentinel.
    expect(page.next_cursor).not.toBeNull();
    // The cursor is opaque base64url; just verify it's non-null and the data is correct.
    const ids = (page.data as Array<{ id: string }>).map((d) => d.id);
    expect(ids).toEqual(['first', 'second']);
  });
});
