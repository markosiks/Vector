import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

import type { Pool } from '@neondatabase/serverless';
import type { NextRequest } from 'next/server';

import type { PolicyEventRow } from '@/lib/db/schema';

/**
 * Hard end-to-end test of the `policy_events` feed through the **real** route
 * handler, cursor codec, repo SQL contract, and DTO mapper — only the Neon
 * boundary is faked, by an in-memory store that honors the exact keyset the repo
 * emits (`(created_at, id)` strict-older seek, deterministic
 * `created_at DESC, id DESC` order).
 *
 * Stresses the properties the demo's red-alert rail depends on:
 *  - paging a large feed with same-timestamp bursts walks every row exactly once
 *    (no gap, no duplicate), in total deterministic order;
 *  - a REJECT written "just now" is visible at the head on the next poll.
 */

// ── In-memory feed that mimics the keyset query ────────────────────────────
const feed: PolicyEventRow[] = [];

/** Desc comparator matching `ORDER BY created_at DESC, id DESC`. */
function descCmp(a: PolicyEventRow, b: PolicyEventRow): number {
  const ta = a.created_at.getTime();
  const tb = b.created_at.getTime();
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

// A fake pool injected through the db client's `setPoolForTest` seam (NOT a
// `mock.module` on the driver — Bun links static imports eagerly, so a
// process-wide driver mock would leak into the real-Neon integration suites in a
// one-process `bun test`). The query honors the exact keyset contract the repo
// emits.
class MockPool {
  async query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: PolicyEventRow[]; rowCount: number | null }> {
    if (!sql.includes('FROM policy_events')) return { rows: [], rowCount: 0 };
    const sorted = [...feed].sort(descCmp);
    const p = params ?? [];

    let start = 0;
    let limit: number;
    if (p.length === 1) {
      limit = p[0] as number;
    } else {
      // Keyset page: params are [t, id, limit]; seek to strictly-older rows.
      const t = new Date(p[0] as string).getTime();
      const id = p[1] as string;
      limit = p[2] as number;
      start = sorted.findIndex((r) => {
        const rt = r.created_at.getTime();
        return rt < t || (rt === t && r.id < id);
      });
      if (start === -1) start = sorted.length;
    }
    const rows = sorted.slice(start, start + limit);
    return { rows, rowCount: rows.length };
  }
}

// `server-only` throws outside an RSC bundle; neutralising it is harmless.
mock.module('server-only', () => ({}));

let resetPool: () => void;
let setPoolForTest: (p: Pool | undefined) => void;
let prevDbUrl: string | undefined;
let GET: (req: NextRequest) => Promise<Response>;

beforeAll(async () => {
  // `??=`: never clobber a real `DATABASE_URL`. This file injects a fake pool, so
  // it never connects; overwriting would freeze the process-wide `ENV.DATABASE_URL`
  // to a fake and break the real-Neon integration probes that run later in a
  // one-process `bun test`. Restored in `afterAll` so it can't un-skip integration.
  prevDbUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL ??= 'postgresql://user:pass@host.neon.tech/db?sslmode=require';
  const client = await import('@/lib/db/client');
  resetPool = client.resetPool;
  setPoolForTest = client.setPoolForTest;
  resetPool();
  setPoolForTest(new MockPool() as unknown as Pool); // the route's `getPool()` → this fake
  GET = (await import('@/app/api/policy-events/route')).GET;
});

afterAll(() => {
  feed.length = 0;
  resetPool();
  if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDbUrl;
});

function makeEvent(createdAtMs: number): PolicyEventRow {
  return {
    id: crypto.randomUUID(),
    intent_id: crypto.randomUUID(),
    agent_id: '11111111-1111-1111-1111-111111111111',
    round_id: '22222222-2222-2222-2222-222222222222',
    rule_fired: 'leverage_cap',
    decision: 'REJECT',
    severity: 'hard',
    detail_json: null,
    created_at: new Date(createdAtMs),
  };
}

const req = (url: string): NextRequest => ({ url }) as unknown as NextRequest;

interface PageBody {
  data: { id: string; created_at: string }[];
  next_cursor: string | null;
}

async function fetchPage(limit: number, cursor: string | null): Promise<PageBody> {
  const url = `http://x/api/policy-events?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const res = await GET(req(url));
  expect(res.status).toBe(200);
  return (await res.json()) as PageBody;
}

describe('keyset pagination walks the whole feed deterministically', () => {
  test('233 events with timestamp ties, page size 17: every id once, in order', async () => {
    feed.length = 0;
    // 233 events across ~30 timestamps ⇒ many same-`created_at` bursts.
    const base = Date.parse('2026-06-07T00:00:00.000Z');
    for (let i = 0; i < 233; i += 1) {
      feed.push(makeEvent(base + (i % 30) * 1000));
    }
    const expected = [...feed].sort(descCmp).map((e) => e.id);

    const collected: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page: PageBody = await fetchPage(17, cursor);
      collected.push(...page.data.map((d) => d.id));
      cursor = page.next_cursor;
      guard += 1;
      expect(guard).toBeLessThan(100); // no infinite loop
    } while (cursor !== null);

    expect(collected).toEqual(expected); // same order, no gap, no duplicate
    expect(new Set(collected).size).toBe(233); // no duplicates
  });
});

describe('near-real-time: a just-written REJECT is visible at the head', () => {
  test('an event newer than everything appears first on the next poll', async () => {
    feed.length = 0;
    const base = Date.parse('2026-06-07T00:00:00.000Z');
    for (let i = 0; i < 10; i += 1) feed.push(makeEvent(base + i * 1000));

    // A new REJECT lands "now" — newer than the existing feed.
    const fresh = makeEvent(base + 1_000_000);
    feed.push(fresh);

    const page = await fetchPage(5, null);
    expect(page.data[0]?.id).toBe(fresh.id);
  });
});
