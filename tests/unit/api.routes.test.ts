import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';

import type { NextRequest } from 'next/server';

import { decodeCursor } from '@/lib/api/cursor';
import {
  agentRowFixture,
  attestationRowFixture,
  intentRowFixture,
  leaderboardRowFixture,
  outcomeRowFixture,
  policyEventRowFixture,
  roundRowFixture,
  scoreRowFixture,
} from '../fixtures/read-api-fixtures';

/**
 * The route handlers wired to a fake pool: the real repo SQL builders and DTO
 * mappers run; only the Neon trust boundary is mocked. Asserts the happy shapes,
 * the error mapping (400/404/503), the no-store cache header, and keyset
 * pagination's `next_cursor` signaling.
 */

// A programmable responder, keyed off the SQL text each repo emits.
let respond: (sql: string, params?: readonly unknown[]) => Record<string, unknown>[] = () => [];

// Mock only the Neon driver (not `@/lib/db/client`, whose full surface other
// test files rely on): the real `getPool` builds a pool from this mock, and the
// repos call `pool.query` directly through the `Queryable` contract.
class MockPool {
  on(): this {
    return this;
  }
  async query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    const rows = respond(sql, params);
    return { rows, rowCount: rows.length };
  }
}

mock.module('server-only', () => ({}));
mock.module('@neondatabase/serverless', () => ({ Pool: MockPool }));

let resetPool: () => void;
let prevDbUrl: string | undefined;
let leaderboardGET: (req: NextRequest) => Promise<Response>;
let policyEventsGET: (req: NextRequest) => Promise<Response>;
let attestationsGET: (req: NextRequest) => Promise<Response>;
let agentGET: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

beforeAll(async () => {
  // A valid string so eager env validation passes. Restored in `afterAll` so it
  // never leaks into the integration files' `hasDb` check (bun evaluates each
  // file lazily just before running it, so a lingering value would un-skip them).
  prevDbUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://user:pass@host.neon.tech/db?sslmode=require';
  resetPool = (await import('@/lib/db/client')).resetPool;
  resetPool(); // drop any pool a prior file primed with the real driver
  leaderboardGET = (await import('@/app/api/leaderboard/route')).GET;
  policyEventsGET = (await import('@/app/api/policy-events/route')).GET;
  attestationsGET = (await import('@/app/api/attestations/route')).GET;
  agentGET = (await import('@/app/api/agents/[id]/route')).GET;
});

afterEach(() => {
  respond = () => [];
});

afterAll(() => {
  resetPool(); // don't leak this file's mocked pool to later test files
  if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDbUrl;
});

const req = (url: string): NextRequest => ({ url }) as unknown as NextRequest;

describe('GET /api/leaderboard', () => {
  test('200, no-store, round + ranked entries with allocation + unit label', async () => {
    respond = (sql) => {
      if (sql.includes('FROM rounds')) return [{ ...roundRowFixture }];
      if (sql.includes('LEFT JOIN capital_allocations')) return [{ ...leaderboardRowFixture }];
      return [];
    };
    const res = await leaderboardGET(req('http://x/api/leaderboard'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as {
      round: { index: number } | null;
      capital_unit: string;
      data: { allocation: string }[];
    };
    expect(body.round?.index).toBe(4);
    expect(body.capital_unit).toBe('tMNT');
    expect(body.data[0]?.allocation).toBe('250000.123456789012345678');
  });

  test('empty DB: round null, empty data array (not an error)', async () => {
    respond = () => [];
    const res = await leaderboardGET(req('http://x/api/leaderboard'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { round: null; data: unknown[] };
    expect(body.round).toBeNull();
    expect(body.data).toEqual([]);
  });

  test('invalid limit → 400', async () => {
    const res = await leaderboardGET(req('http://x/api/leaderboard?limit=-3'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_limit');
  });

  test('DB unavailable → 503', async () => {
    respond = () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    };
    const res = await leaderboardGET(req('http://x/api/leaderboard'));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'service_unavailable',
    );
  });
});

describe('GET /api/policy-events', () => {
  test('full page → next_cursor pins the last row', async () => {
    respond = () => [{ ...policyEventRowFixture }];
    // limit=1 and one row returned ⇒ page is "full" ⇒ a cursor is offered.
    const res = await policyEventsGET(req('http://x/api/policy-events?limit=1'));
    const body = (await res.json()) as { data: unknown[]; next_cursor: string | null };
    expect(body.data).toHaveLength(1);
    expect(body.next_cursor).not.toBeNull();
    expect(decodeCursor(body.next_cursor as string).id).toBe(policyEventRowFixture.id);
  });

  test('short page → next_cursor is null (terminal)', async () => {
    respond = () => [{ ...policyEventRowFixture }];
    const res = await policyEventsGET(req('http://x/api/policy-events?limit=50'));
    const body = (await res.json()) as { next_cursor: string | null };
    expect(body.next_cursor).toBeNull();
  });

  test('invalid cursor → 400', async () => {
    const res = await policyEventsGET(req('http://x/api/policy-events?cursor=garbage!!'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_cursor');
  });
});

describe('GET /api/attestations', () => {
  test('200 with chain_state filter forwarded', async () => {
    let seenParams: readonly unknown[] | undefined;
    respond = (_sql, params) => {
      seenParams = params;
      return [{ ...attestationRowFixture }];
    };
    const res = await attestationsGET(req('http://x/api/attestations?chain_state=confirmed'));
    expect(res.status).toBe(200);
    expect(seenParams?.[0]).toBe('confirmed');
    const body = (await res.json()) as { data: { value: string }[] };
    expect(body.data[0]?.value).toBe('170141183460469231731687303715884105727');
  });

  test('invalid chain_state → 400', async () => {
    const res = await attestationsGET(req('http://x/api/attestations?chain_state=pending'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_chain_state',
    );
  });
});

describe('GET /api/agents/[id]', () => {
  const params = (id: string): { params: Promise<{ id: string }> } => ({
    params: Promise.resolve({ id }),
  });

  test('200 composite detail with side-by-side lists', async () => {
    respond = (sql) => {
      if (sql.startsWith('SELECT * FROM agents WHERE id')) return [{ ...agentRowFixture }];
      if (sql.includes('FROM scores')) return [{ ...scoreRowFixture }];
      if (sql.includes('FROM intents')) return [{ ...intentRowFixture }];
      if (sql.includes('FROM policy_events')) return [{ ...policyEventRowFixture }];
      if (sql.includes('FROM outcomes')) return [{ ...outcomeRowFixture }];
      return [];
    };
    const res = await agentGET(req('http://x/api/agents/x'), params(agentRowFixture.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agent: { id: string; signature?: unknown };
      intents: Record<string, unknown>[];
      policy_events: { intent_id: string }[];
    };
    expect(body.agent.id).toBe(agentRowFixture.id);
    // The decision correlates to the intent by intent_id, side by side.
    expect(body.policy_events[0]?.intent_id).toBe(intentRowFixture.id);
    expect(JSON.stringify(body)).not.toContain('should-never-leak');
  });

  test('well-formed but missing id → 404', async () => {
    respond = () => [];
    const res = await agentGET(req('http://x/api/agents/x'), params(agentRowFixture.id));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('agent_not_found');
  });

  test('malformed id → 400 (distinct from 404)', async () => {
    const res = await agentGET(req('http://x/api/agents/x'), params('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_id');
  });
});
