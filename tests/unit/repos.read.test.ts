import { describe, expect, test } from 'bun:test';

import { listAttestationsPage } from '@/lib/db/repos/attestations';
import { listLeaderboard } from '@/lib/db/repos/leaderboard';
import { listRecentOutcomesByAgent } from '@/lib/db/repos/outcomes';
import { listPolicyEventsPage, listRecentPolicyEventsByAgent } from '@/lib/db/repos/policy-events';
import { getLatestRound } from '@/lib/db/repos/rounds';
import { listScoreHistoryByAgent, SCORE_HISTORY_MAX } from '@/lib/db/repos/scores';
import type { Queryable } from '@/lib/db/types';

/**
 * The read repos build parameterized statements. These tests assert the SQL
 * shape (ordering, tie-breakers, keyset predicate, casts) and that every value
 * is bound as a `$n` parameter — never inlined — using a fake `Queryable` that
 * returns no rows (so zod parsing is a no-op and we observe only the statement).
 */

class SpyDb implements Queryable {
  public last?: { sql: string; params: readonly unknown[] | undefined };
  async query<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    this.last = { sql, params };
    return { rows: [], rowCount: 0 };
  }
}

const TS = '2026-06-07T12:00:00.000Z';
const ID = '55555555-5555-5555-5555-555555555555';
const AGENT = '11111111-1111-1111-1111-111111111111';
const ROUND = '22222222-2222-2222-2222-222222222222';

describe('listLeaderboard', () => {
  test('with a round LEFT JOINs allocations and binds (round, limit)', async () => {
    const db = new SpyDb();
    await listLeaderboard(db, ROUND, 25);
    expect(db.last?.sql).toContain('LEFT JOIN capital_allocations');
    expect(db.last?.sql).toContain('ORDER BY a.score_current DESC, a.created_at ASC');
    expect(db.last?.params).toEqual([ROUND, 25]);
  });

  test('with no round yields a NULL allocation and binds only the limit', async () => {
    const db = new SpyDb();
    await listLeaderboard(db, null, 10);
    expect(db.last?.sql).toContain('NULL::numeric AS allocation_amount');
    expect(db.last?.sql).not.toContain('LEFT JOIN');
    expect(db.last?.params).toEqual([10]);
  });
});

describe('getLatestRound', () => {
  test('orders by index DESC and takes one', async () => {
    const db = new SpyDb();
    await getLatestRound(db);
    expect(db.last?.sql).toBe('SELECT * FROM rounds ORDER BY index DESC LIMIT 1');
  });
});

describe('listPolicyEventsPage', () => {
  test('head page: deterministic order, binds only the limit', async () => {
    const db = new SpyDb();
    await listPolicyEventsPage(db, 50);
    expect(db.last?.sql).toContain('ORDER BY created_at DESC, id DESC');
    expect(db.last?.sql).not.toContain('WHERE');
    // F-06: repo fetches limit+1 so the API layer can detect a further page.
    expect(db.last?.params).toEqual([51]);
  });

  test('keyset page: seek predicate with casts, binds (t, id, limit)', async () => {
    const db = new SpyDb();
    await listPolicyEventsPage(db, 50, { t: TS, id: ID });
    const sql = db.last?.sql ?? '';
    expect(sql).toContain('WHERE (created_at < $1::timestamptz');
    expect(sql).toContain('id < $2::uuid');
    expect(sql).toContain('LIMIT $3');
    expect(db.last?.params).toEqual([TS, ID, 51]); // F-06: limit+1 fetch
  });

  test('selects a microsecond-precision cursor_t key (avoids ms-truncation row loss)', async () => {
    const db = new SpyDb();
    await listPolicyEventsPage(db, 50);
    const sql = db.last?.sql ?? '';
    // The driver truncates timestamptz to ms; the cursor must come from SQL at
    // full microsecond precision, not from the row's JS Date.
    expect(sql).toContain("to_char(created_at AT TIME ZONE 'UTC'");
    expect(sql).toContain('.US"Z"');
    expect(sql).toContain('AS cursor_t');
  });
});

describe('listRecentPolicyEventsByAgent', () => {
  test('filters by agent with a deterministic order', async () => {
    const db = new SpyDb();
    await listRecentPolicyEventsByAgent(db, AGENT, 20);
    expect(db.last?.sql).toContain('WHERE agent_id = $1 ORDER BY created_at DESC, id DESC');
    expect(db.last?.params).toEqual([AGENT, 20]);
  });
});

describe('listAttestationsPage', () => {
  test('no filter, no cursor: binds only the limit', async () => {
    const db = new SpyDb();
    await listAttestationsPage(db, { limit: 30 });
    expect(db.last?.sql).not.toContain('WHERE');
    expect(db.last?.params).toEqual([31]); // F-06: limit+1 fetch
  });

  test('chain_state filter binds first', async () => {
    const db = new SpyDb();
    await listAttestationsPage(db, { limit: 30, chainState: 'optimistic' });
    expect(db.last?.sql).toContain('WHERE chain_state = $1');
    expect(db.last?.params).toEqual(['optimistic', 31]); // F-06: limit+1 fetch
  });

  test('filter + cursor compose with correct placeholder order', async () => {
    const db = new SpyDb();
    await listAttestationsPage(db, {
      limit: 30,
      chainState: 'confirmed',
      before: { t: TS, id: ID },
    });
    const sql = db.last?.sql ?? '';
    expect(sql).toContain('chain_state = $1');
    expect(sql).toContain('created_at < $2::timestamptz');
    expect(sql).toContain('id < $3::uuid');
    expect(sql).toContain('LIMIT $4');
    expect(db.last?.params).toEqual(['confirmed', TS, ID, 31]); // F-06: limit+1 fetch
  });
});

describe('listRecentOutcomesByAgent', () => {
  test('deterministic newest-first order', async () => {
    const db = new SpyDb();
    await listRecentOutcomesByAgent(db, AGENT, 15);
    expect(db.last?.sql).toContain('WHERE agent_id = $1 ORDER BY created_at DESC, id DESC');
    expect(db.last?.params).toEqual([AGENT, 15]);
  });
});

describe('listScoreHistoryByAgent', () => {
  test('selects the most recent rounds by index, returned oldest-first, bounded by a limit', async () => {
    const db = new SpyDb();
    await listScoreHistoryByAgent(db, AGENT);
    expect(db.last?.sql).toContain('JOIN rounds r ON r.id = s.round_id');
    // Inner: newest rounds first (round index, not created_at) so the LIMIT keeps the recent window.
    expect(db.last?.sql).toContain('ORDER BY r.index DESC, s.id DESC');
    // Outer: flipped back to ascending for the EWMA curve.
    expect(db.last?.sql).toContain('ORDER BY round_index ASC, id ASC');
    expect(db.last?.sql).toContain('LIMIT $2');
    expect(db.last?.params).toEqual([AGENT, SCORE_HISTORY_MAX]);
  });

  test('forwards an explicit limit', async () => {
    const db = new SpyDb();
    await listScoreHistoryByAgent(db, AGENT, 250);
    expect(db.last?.params).toEqual([AGENT, 250]);
  });
});
