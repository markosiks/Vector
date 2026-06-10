/**
 * Regression tests for audit findings A-03, A-04, A-07, A-08.
 *
 * Each test is narrowly scoped to the specific behavioral contract the finding
 * identified, using fakes rather than implementation details.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Address, Hex } from 'viem';

import { resetInFlightForTest, submitAndReconcile } from '@/lib/attestation/pipeline';
import { AttestationSubmitError, buildFeedbackUri } from '@/lib/attestation/submit';
import type { IdentityReader } from '@/lib/chain/identity';
import type { AttestationRow } from '@/lib/db/schema';
import type { FeedbackWriteArgs, FeedbackWriteClient } from '@/lib/attestation/submit';
import type { FeedbackReceipt, ReceiptReader } from '@/lib/attestation/reconcile';

import { FakeAttestationDb } from '@/tests/fixtures/attestation-db';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const AGENT = '11111111-1111-1111-1111-111111111111';
const ROUND = '22222222-2222-2222-2222-222222222222';
const ATTESTOR = '0x00000000000000000000000000000000000000a1' as Address;
const TX_HASH = `0x${'c'.repeat(64)}` as Hex;
const BASE = 'https://vector.app';

function optimisticRow(over: Partial<AttestationRow> = {}): AttestationRow {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    agent_id: AGENT,
    round_id: ROUND,
    value: '74',
    value_decimals: 0,
    tag1: ROUND,
    tag2: 'violation',
    feedback_uri: null,
    feedback_hash: `0x${'a'.repeat(64)}`,
    feedback_detail: '{"schema":"vector.attestation.detail/1"}',
    chain_state: 'optimistic',
    tx_hash: null,
    block_number: null,
    created_at: new Date('2026-06-06T00:00:00Z'),
    confirmed_at: null,
    ...over,
  };
}

function attestableReader(): IdentityReader {
  return {
    ownerOf: async () => '0x00000000000000000000000000000000000000ff' as Address,
    isAuthorizedOrOwner: async () => false,
  };
}

function immediateReceiptReader(status: FeedbackReceipt['status'] = 'success'): ReceiptReader {
  return {
    getReceipt: async () => ({ status, blockNumber: 1n }),
  };
}

function makeDeps(db: FakeAttestationDb) {
  let callCount = 0;
  const writer: FeedbackWriteClient = {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    giveFeedback: async (_args: FeedbackWriteArgs): Promise<Hex> => {
      callCount += 1;
      // Simulate non-trivial async work so a concurrent call can race
      await new Promise<void>((r) => setTimeout(r, 0));
      return TX_HASH;
    },
  };
  return {
    submitDeps: { db, writer, reader: attestableReader(), attestor: ATTESTOR, baseUrl: BASE },
    reconcileDeps: { receipts: immediateReceiptReader() },
    getCallCount: () => callCount,
  };
}

// ---------------------------------------------------------------------------
// A-03: In-process coalescing — concurrent submits for the same attestationId
//       must NOT send two giveFeedback calls.
// ---------------------------------------------------------------------------

describe('A-03: submitAndReconcile in-process coalescing', () => {
  afterEach(() => resetInFlightForTest());

  test('concurrent calls for the same attestationId share one giveFeedback call', async () => {
    const row = optimisticRow();
    const db = new FakeAttestationDb([row]);
    const { submitDeps, reconcileDeps, getCallCount } = makeDeps(db);

    const params = { attestationId: row.id, agentOnchainId: '7' };

    // Launch two concurrent submits without awaiting between them
    const [r1, r2] = await Promise.all([
      submitAndReconcile(submitDeps, reconcileDeps, params),
      submitAndReconcile(submitDeps, reconcileDeps, params),
    ]);

    // Only one on-chain call should have been made
    expect(getCallCount()).toBe(1);
    // Both callers get the same result
    expect(r1.submit.status).toBe(r2.submit.status);
    expect(r1.submit.txHash).toBe(r2.submit.txHash);
  });

  test('sequential calls after the first settles do not coalesce (independent retries work)', async () => {
    // First call: submitted successfully
    const row = optimisticRow();
    const db = new FakeAttestationDb([row]);
    const { submitDeps, reconcileDeps, getCallCount } = makeDeps(db);

    const params = { attestationId: row.id, agentOnchainId: '7' };
    await submitAndReconcile(submitDeps, reconcileDeps, params);
    // Second call after first settles: idempotent (already_submitted), but a new
    // call is dispatched (not coalesced with the completed first).
    const r2 = await submitAndReconcile(submitDeps, reconcileDeps, params);

    // The second call hits the idempotent path, not a second on-chain write
    expect(r2.submit.status).toBe('already_submitted');
    // Only 1 actual giveFeedback was ever sent
    expect(getCallCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A-04: https enforcement — http:// must be rejected in non-development envs.
//
// `buildFeedbackUri` accepts an injectable `nodeEnv` third parameter so tests
// do not need to mutate the read-only `process.env.NODE_ENV` (which TypeScript
// rightly rejects). The production call site passes `process.env.NODE_ENV`.
// ---------------------------------------------------------------------------

describe('A-04: buildFeedbackUri https enforcement', () => {
  test('allows https:// in any environment', () => {
    expect(() => buildFeedbackUri('https://vector.app', 'x', 'production')).not.toThrow();
    expect(() => buildFeedbackUri('https://vector.app', 'x', 'development')).not.toThrow();
  });

  test('allows http:// in development', () => {
    expect(() => buildFeedbackUri('http://localhost:3000', 'x', 'development')).not.toThrow();
  });

  test('rejects http:// in production', () => {
    expect(() => buildFeedbackUri('http://vector.app', 'x', 'production')).toThrow(AttestationSubmitError);
  });

  test('rejects http:// when NODE_ENV is undefined (treated as non-dev)', () => {
    expect(() => buildFeedbackUri('http://vector.app', 'x', undefined)).toThrow(AttestationSubmitError);
  });
});

// ---------------------------------------------------------------------------
// A-07: raced status returns fresh attestation with winner's tx_hash, not null.
// ---------------------------------------------------------------------------

describe('A-07: raced submit returns fresh attestation row', () => {
  test('the raced result carries the winner tx_hash from a re-read, not null', async () => {
    const row = optimisticRow();
    const WINNER_HASH = `0x${'d'.repeat(64)}` as Hex;

    // A DB that:
    //  - returns the optimistic row on SELECT by id
    //  - returns 0 rows on the UPDATE (lost the race)
    //  - returns the winner's row on the re-read SELECT
    let updateAttempts = 0;
    const racingDb = {
      async query<R = Record<string, unknown>>(sql: string) {
        if (sql.includes('SET feedback_uri')) {
          updateAttempts += 1;
          return { rows: [] as R[], rowCount: 0 }; // lost race
        }
        if (sql.includes('WHERE id = $1')) {
          // First call returns the pre-update row; after the update attempt,
          // return the winner's row with tx_hash set.
          if (updateAttempts > 0) {
            const winner = { ...row, tx_hash: WINNER_HASH, feedback_uri: 'https://example.com/x' };
            return { rows: [winner] as unknown as R[], rowCount: 1 };
          }
          return { rows: [row] as unknown as R[], rowCount: 1 };
        }
        return { rows: [] as R[], rowCount: 0 };
      },
    };

    const writer: FeedbackWriteClient = {
      giveFeedback: async () => `0x${'e'.repeat(64)}` as Hex,
    };

    const { submitAttestation } = await import('@/lib/attestation/submit');
    const result = await submitAttestation(
      { db: racingDb, writer, reader: attestableReader(), attestor: ATTESTOR, baseUrl: BASE },
      { attestationId: row.id, agentOnchainId: '7' },
    );

    expect(result.status).toBe('raced');
    // The returned attestation must reflect the winner's tx_hash (not null)
    expect(result.attestation.tx_hash).toBe(WINNER_HASH);
  });
});

// ---------------------------------------------------------------------------
// A-08: mirrorAttestation value-free error — no UUIDs in error message.
// ---------------------------------------------------------------------------

describe('A-08: mirrorAttestation value-free error message', () => {
  test('row-vanished error contains no agent UUID or round ID', async () => {
    // A DB that reports a conflict on INSERT but returns nothing on SELECT
    // (simulates the row vanishing between conflict and re-read).
    const trickyDb = {
      async query<R = Record<string, unknown>>(sql: string) {
        if (sql.startsWith('INSERT INTO attestations')) {
          // Simulate ON CONFLICT DO NOTHING → empty result (conflict path)
          return { rows: [] as R[], rowCount: 0 };
        }
        if (sql.includes('FROM intents')) {
          return { rows: [] as R[], rowCount: 0 };
        }
        // All selects (including getAttestationByAgentRound) return empty
        return { rows: [] as R[], rowCount: 0 };
      },
    };

    const { mirrorAttestation: mirror } = await import('@/lib/attestation/pipeline');
    const agentUuid = '11111111-1111-1111-1111-111111111111';
    const roundId = '22222222-2222-2222-2222-222222222222';

    let caught: Error | undefined;
    try {
      await mirror(trickyDb, {
        agent: { seedId: 'alpha', uuid: agentUuid, onchainId: null },
        roundId,
        result: { raw_r: '70', score_r: '73', crashed: false, components: { perf: 0.5, w: 0.25, policy: 0.9, dd: 0.05 } },
        inputs: { pnl_r: 0, car_r: 0, dd_r: 0, soft: 0, hard: 0, halt: 0, drain_r: false },
        outcomes: [],
        policyEvents: [],
      });
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    // The error message must NOT contain the agent UUID or round ID (A-08)
    expect(caught!.message).not.toContain(agentUuid);
    expect(caught!.message).not.toContain(roundId);
    // It should still say "vanished" so it's diagnosable
    expect(caught!.message).toContain('vanished');
  });
});
