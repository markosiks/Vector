import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { keccak256, toBytes } from 'viem';

import type { Pool } from '@neondatabase/serverless';

/**
 * In-process tests for `GET /api/attestations/[id]/feedback` — the endpoint that
 * serves the off-chain feedback detail at the on-chain `feedbackURI`. Only
 * `server-only` (a no-op outside Next) is mocked; the Neon round-trip is faked by
 * injecting a pool through the db client's `setPoolForTest` seam, mirroring
 * `health.route.test.ts`, so the route + db-client + repo wiring is exercised for
 * real without a server or live DB.
 *
 * The contract under test: the body is the **exact stored bytes** (so it
 * re-hashes to the stored `feedback_hash`), the type is pinned (`nosniff`,
 * `no-store`), and a malformed/absent id fails closed (400 / 404).
 */

mock.module('server-only', () => ({}));

// A valid DB string so eager env validation passes when the route imports env.
const prevDbUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL ??= 'postgresql://user:pass@host.neon.tech/db?sslmode=require';

const ID = '11111111-1111-4111-8111-111111111111';
const DETAIL_JSON = '{"schema":"vector.attestation.detail/1","round_id":"r-1"}';
const DETAIL_HASH = keccak256(toBytes(DETAIL_JSON));

function attestationRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: ID,
    agent_id: '22222222-2222-4222-8222-222222222222',
    round_id: '33333333-3333-4333-8333-333333333333',
    value: '82',
    value_decimals: 0,
    tag1: '33333333-3333-4333-8333-333333333333',
    tag2: 'clean',
    feedback_uri: `https://vector.app/api/attestations/${ID}/feedback`,
    feedback_hash: DETAIL_HASH,
    feedback_detail: DETAIL_JSON,
    chain_state: 'confirmed',
    tx_hash: `0x${'b'.repeat(64)}`,
    block_number: '4242',
    confirmed_at: new Date(),
    created_at: new Date(),
    ...overrides,
  };
}

// What the fake pool returns for the `SELECT * FROM attestations WHERE id = $1`.
let selectResult: Record<string, unknown>[] = [];

class MockPool {
  async query(sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    if (sql.includes('FROM attestations')) {
      return { rows: selectResult, rowCount: selectResult.length };
    }
    return { rows: [], rowCount: 0 };
  }
}

const GET = (await import('@/app/api/attestations/[id]/feedback/route')).GET as (
  req: unknown,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;
const setPoolForTest: (p: Pool | undefined) => void = (await import('@/lib/db/client'))
  .setPoolForTest;

beforeEach(() => {
  setPoolForTest(new MockPool() as unknown as Pool);
  selectResult = [];
});

afterAll(() => {
  setPoolForTest(undefined);
  if (prevDbUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = prevDbUrl;
  }
});

function call(id: string): Promise<Response> {
  return GET(undefined, { params: Promise.resolve({ id }) });
}

describe('GET /api/attestations/[id]/feedback', () => {
  test('serves the exact stored bytes, pinned and unsniffable, that re-hash to feedback_hash', async () => {
    selectResult = [attestationRow({})];

    const res = await call(ID);
    const body = await res.text();

    expect(res.status).toBe(200);
    // The body is the stored bytes verbatim — not a re-serialization.
    expect(body).toBe(DETAIL_JSON);
    // …so the integrity anchor holds: KECCAK-256(body) === the echoed hash.
    expect(keccak256(toBytes(body))).toBe(DETAIL_HASH);
    expect(res.headers.get('X-Feedback-Hash')).toBe(DETAIL_HASH);
    expect(res.headers.get('ETag')).toBe(`"${DETAIL_HASH}"`);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  test('a well-formed id with no attestation is 404 (not a 500)', async () => {
    selectResult = [];
    const res = await call(ID);
    expect(res.status).toBe(404);
  });

  test('an optimistic row whose detail is not built yet is 404', async () => {
    selectResult = [
      attestationRow({ feedback_detail: null, chain_state: 'optimistic', tx_hash: null }),
    ];
    const res = await call(ID);
    expect(res.status).toBe(404);
  });

  test('a malformed id fails closed at 400 before any query', async () => {
    const res = await call('not-a-uuid');
    expect(res.status).toBe(400);
  });
});
