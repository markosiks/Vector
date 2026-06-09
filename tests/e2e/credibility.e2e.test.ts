import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

import type { Pool } from '@neondatabase/serverless';
import type { NextRequest } from 'next/server';

import type { AttestationDto } from '@/lib/api/dto';
import type { AttestationRow } from '@/lib/db/schema';
import {
  chainStateMeta,
  explorerBlockUrl,
  explorerTxUrl,
  isStuckOptimistic,
} from '@/lib/credibility';

/**
 * End-to-end for the Attestation Log's data path: the **real**
 * `GET /api/attestations` route handler → cursor codec → repo SQL contract →
 * `toAttestationDto` mapper → the credibility logic the screen renders from.
 * Only the Neon boundary is faked, by an in-memory store that honours the exact
 * keyset the repo emits (`(created_at, id)` strict-older seek; `created_at DESC,
 * id DESC` order) and the optional `chain_state` filter.
 *
 * It exercises the properties the screen depends on:
 *  - a freshly-confirmed attestation is visible at the head on the next poll
 *    (the `optimistic → confirmed` transition the badge animates);
 *  - the `chain_state` filter narrows the feed server-side;
 *  - keyset paging walks a long history exactly once, no gap/dup;
 *  - explorer links are built only for well-formed on-chain fields.
 */

const feed: AttestationRow[] = [];

function descCmp(a: AttestationRow, b: AttestationRow): number {
  const ta = a.created_at.getTime();
  const tb = b.created_at.getTime();
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Fake Neon pool honouring the attestations page query's param contract. */
class MockPool {
  async query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: (AttestationRow & { cursor_t: string })[]; rowCount: number | null }> {
    if (!sql.includes('FROM attestations')) return { rows: [], rowCount: 0 };
    const p = params ?? [];
    let i = 0;

    let filtered = [...feed];
    if (/chain_state = \$/.test(sql)) {
      const state = p[i++] as string;
      filtered = filtered.filter((r) => r.chain_state === state);
    }

    let seek: { t: number; id: string } | null = null;
    if (/created_at < \$/.test(sql)) {
      const t = new Date(p[i++] as string).getTime();
      const id = p[i++] as string;
      seek = { t, id };
    }
    const limit = p[i] as number;

    const sorted = filtered.sort(descCmp);
    let start = 0;
    if (seek) {
      start = sorted.findIndex((r) => {
        const rt = r.created_at.getTime();
        return rt < seek!.t || (rt === seek!.t && r.id < seek!.id);
      });
      if (start === -1) start = sorted.length;
    }
    const rows = sorted
      .slice(start, start + limit)
      .map((r) => ({ ...r, cursor_t: r.created_at.toISOString() }));
    return { rows, rowCount: rows.length };
  }
}

mock.module('server-only', () => ({}));

let resetPool: () => void;
let setPoolForTest: (p: Pool | undefined) => void;
let prevDbUrl: string | undefined;
let GET: (req: NextRequest) => Promise<Response>;

beforeAll(async () => {
  prevDbUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL ??= 'postgresql://user:pass@host.neon.tech/db?sslmode=require';
  const client = await import('@/lib/db/client');
  resetPool = client.resetPool;
  setPoolForTest = client.setPoolForTest;
  resetPool();
  setPoolForTest(new MockPool() as unknown as Pool);
  GET = (await import('@/app/api/attestations/route')).GET;
});

afterAll(() => {
  feed.length = 0;
  resetPool();
  if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDbUrl;
});

const TX = `0x${'b'.repeat(64)}`;

function makeAttestation(
  createdAtMs: number,
  chain_state: AttestationRow['chain_state'],
  over: Partial<AttestationRow> = {},
): AttestationRow {
  return {
    id: crypto.randomUUID(),
    agent_id: '11111111-1111-1111-1111-111111111111',
    round_id: '22222222-2222-2222-2222-222222222222',
    value: '73',
    value_decimals: 0,
    tag1: 'agentscore',
    tag2: null,
    feedback_uri: 'ipfs://x',
    feedback_hash: `0x${'a'.repeat(64)}`,
    feedback_detail: null,
    chain_state,
    tx_hash: chain_state === 'optimistic' ? null : TX,
    block_number: chain_state === 'confirmed' ? '12345678' : null,
    created_at: new Date(createdAtMs),
    confirmed_at: chain_state === 'confirmed' ? new Date(createdAtMs + 4000) : null,
    ...over,
  };
}

const req = (url: string): NextRequest => ({ url }) as unknown as NextRequest;

interface PageBody {
  data: AttestationDto[];
  next_cursor: string | null;
}

async function fetchPage(query: string): Promise<PageBody> {
  const res = await GET(req(`http://x/api/attestations?${query}`));
  expect(res.status).toBe(200);
  return (await res.json()) as PageBody;
}

describe('optimistic → confirmed is visible at the head on the next poll', () => {
  test('a row flips state in place and the screen logic reflects it', async () => {
    feed.length = 0;
    const base = Date.parse('2026-06-07T12:00:00.000Z');
    const att = makeAttestation(base, 'optimistic');
    feed.push(att);

    const before = (await fetchPage('limit=50')).data[0]!;
    expect(before.chain_state).toBe('optimistic');
    expect(chainStateMeta(before.chain_state).terminal).toBe(false);
    expect(explorerTxUrl(before.tx_hash)).toBeNull(); // no hash yet

    // Reconcile stamps the same row confirmed (new tx/block/confirmed_at).
    att.chain_state = 'confirmed';
    att.tx_hash = TX;
    att.block_number = '777';
    att.confirmed_at = new Date(base + 5000);

    const after = (await fetchPage('limit=50')).data[0]!;
    expect(after.id).toBe(before.id); // same row
    expect(after.chain_state).toBe('confirmed');
    expect(chainStateMeta(after.chain_state).terminal).toBe(true);
    expect(explorerTxUrl(after.tx_hash)).toBe(`${explorerBase()}/tx/${TX}`);
    expect(explorerBlockUrl(after.block_number)).toBe(`${explorerBase()}/block/777`);
  });
});

describe('chain_state filter narrows server-side', () => {
  test('only failed rows return under ?chain_state=failed', async () => {
    feed.length = 0;
    const base = Date.parse('2026-06-07T12:00:00.000Z');
    feed.push(makeAttestation(base, 'optimistic'));
    feed.push(makeAttestation(base + 1000, 'confirmed'));
    feed.push(makeAttestation(base + 2000, 'failed'));

    const failed = await fetchPage('limit=50&chain_state=failed');
    expect(failed.data).toHaveLength(1);
    expect(failed.data[0]!.chain_state).toBe('failed');

    const all = await fetchPage('limit=50');
    expect(all.data).toHaveLength(3);
  });
});

describe('keyset paging walks a long history once', () => {
  test('120 attestations, page 25: every id exactly once, newest first', async () => {
    feed.length = 0;
    const base = Date.parse('2026-06-07T00:00:00.000Z');
    for (let i = 0; i < 120; i += 1) {
      // Burst ties: only ~20 distinct timestamps across 120 rows.
      feed.push(makeAttestation(base + (i % 20) * 1000, 'confirmed'));
    }
    const expected = [...feed].sort(descCmp).map((r) => r.id);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: PageBody = await fetchPage(
        `limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      for (const a of page.data) seen.push(a.id);
      cursor = page.next_cursor;
    } while (cursor);

    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(120);
  });
});

describe('stuck-optimistic detection over real DTOs', () => {
  test('an old optimistic row is flagged stuck; a fresh one is not', async () => {
    feed.length = 0;
    const now = new Date('2026-06-07T12:10:00.000Z');
    feed.push(makeAttestation(now.getTime() - 5 * 60_000, 'optimistic')); // 5 min old
    feed.push(makeAttestation(now.getTime() - 2_000, 'optimistic')); // fresh

    const rows = (await fetchPage('limit=50&chain_state=optimistic')).data;
    const stuck = rows.filter((a) => isStuckOptimistic(a, now));
    expect(stuck).toHaveLength(1);
  });
});

function explorerBase(): string {
  // Mirror the configured explorer origin for the URL assertions.
  return explorerTxUrl(TX)!.replace(`/tx/${TX}`, '');
}
