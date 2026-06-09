import { describe, expect, test } from 'bun:test';
import type { Hex } from 'viem';

import {
  reconcile,
  type FeedbackReceipt,
  type ReceiptReader,
  type ReconcileClock,
} from '@/lib/attestation/reconcile';
import type { AttestationRow } from '@/lib/db/schema';

import { FakeAttestationDb } from '@/tests/fixtures/attestation-db';

/**
 * The receipt watcher is the optimistic→terminal state machine. These pin its
 * deterministic behaviour with an injected clock and a scripted receipt reader:
 * success → confirmed (with block + timestamp), revert → failed, and — the
 * load-bearing safety property — a transport flap or a never-mined tx leaves the
 * row `optimistic` (a later sweep retries) instead of a false `failed`.
 */

const NOW = new Date('2026-06-06T12:00:00Z');
const TX_HASH = `0x${'b'.repeat(64)}` as Hex;

function optimisticRow(over: Partial<AttestationRow> = {}): AttestationRow {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    agent_id: '11111111-1111-1111-1111-111111111111',
    round_id: '22222222-2222-2222-2222-222222222222',
    value: '74',
    value_decimals: 0,
    tag1: null,
    tag2: null,
    feedback_uri: 'https://vector.app/x',
    feedback_hash: `0x${'a'.repeat(64)}`,
    feedback_detail: '{}',
    chain_state: 'optimistic',
    tx_hash: TX_HASH,
    block_number: null,
    created_at: NOW,
    confirmed_at: null,
    ...over,
  };
}

/** A clock that records every requested sleep and never actually waits. */
function fakeClock(): ReconcileClock & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => NOW,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

/** A receipt reader that returns a scripted sequence (a value, `null`, or throws). */
function scriptedReader(
  script: readonly (FeedbackReceipt | null | 'throw')[],
): ReceiptReader & { calls: number } {
  const reader = {
    calls: 0,
    getReceipt: async (): Promise<FeedbackReceipt | null> => {
      const step = script[Math.min(reader.calls, script.length - 1)] ?? null;
      reader.calls += 1;
      if (step === 'throw') {
        throw new Error('rpc flap');
      }
      return step;
    },
  };
  return reader;
}

const success: FeedbackReceipt = { status: 'success', blockNumber: 42n };
const reverted: FeedbackReceipt = { status: 'reverted', blockNumber: 9n };

describe('reconcile', () => {
  test('confirms on a success receipt, persisting block number and timestamp', async () => {
    const row = optimisticRow();
    const db = new FakeAttestationDb([row]);
    const result = await reconcile(
      { db, receipts: scriptedReader([success]), clock: fakeClock() },
      row.id,
    );
    expect(result.status).toBe('confirmed');
    const stored = db.get(row.id);
    expect(stored?.chain_state).toBe('confirmed');
    expect(stored?.block_number).toBe('42');
    expect(stored?.confirmed_at).toEqual(NOW);
  });

  test('fails on a revert receipt (terminal)', async () => {
    const row = optimisticRow();
    const db = new FakeAttestationDb([row]);
    const result = await reconcile(
      { db, receipts: scriptedReader([reverted]), clock: fakeClock() },
      row.id,
    );
    expect(result.status).toBe('failed');
    expect(db.get(row.id)?.chain_state).toBe('failed');
  });

  test('polls with backoff while pending, then confirms', async () => {
    const row = optimisticRow();
    const db = new FakeAttestationDb([row]);
    const clock = fakeClock();
    const reader = scriptedReader([null, null, success]);
    const result = await reconcile(
      { db, receipts: reader, clock, policy: { baseDelayMs: 100, maxDelayMs: 1000 } },
      row.id,
    );
    expect(result.status).toBe('confirmed');
    expect(reader.calls).toBe(3);
    expect(clock.sleeps).toEqual([100, 200]); // exponential between the 3 polls
  });

  test('a never-mined tx exhausts the budget and stays optimistic (no false failed)', async () => {
    const row = optimisticRow();
    const db = new FakeAttestationDb([row]);
    const clock = fakeClock();
    const result = await reconcile(
      { db, receipts: scriptedReader([null]), clock, policy: { maxAttempts: 4 } },
      row.id,
    );
    expect(result.status).toBe('pending');
    expect(db.get(row.id)?.chain_state).toBe('optimistic');
    expect(clock.sleeps).toHaveLength(3); // maxAttempts - 1 inter-poll waits
  });

  test('a transport flap is retried and never mistaken for an on-chain failure', async () => {
    const row = optimisticRow();
    const db = new FakeAttestationDb([row]);
    const result = await reconcile(
      { db, receipts: scriptedReader(['throw']), clock: fakeClock(), policy: { maxAttempts: 3 } },
      row.id,
    );
    expect(result.status).toBe('pending');
    expect(db.get(row.id)?.chain_state).toBe('optimistic');
  });

  test('bounds the backoff delay at maxDelayMs', async () => {
    const row = optimisticRow();
    const db = new FakeAttestationDb([row]);
    const clock = fakeClock();
    await reconcile(
      {
        db,
        receipts: scriptedReader([null]),
        clock,
        policy: { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 250 },
      },
      row.id,
    );
    expect(clock.sleeps).toEqual([100, 200, 250, 250]); // capped at 250
  });

  test('an already-confirmed row is returned without polling (idempotent re-run)', async () => {
    const row = optimisticRow({ chain_state: 'confirmed', block_number: '42', confirmed_at: NOW });
    const db = new FakeAttestationDb([row]);
    const reader = scriptedReader([reverted]);
    const result = await reconcile({ db, receipts: reader, clock: fakeClock() }, row.id);
    expect(result.status).toBe('confirmed');
    expect(reader.calls).toBe(0);
  });

  test('a not-yet-submitted row (no tx hash) is pending with no polling', async () => {
    const row = optimisticRow({ tx_hash: null });
    const db = new FakeAttestationDb([row]);
    const reader = scriptedReader([success]);
    const result = await reconcile({ db, receipts: reader, clock: fakeClock() }, row.id);
    expect(result.status).toBe('pending');
    expect(reader.calls).toBe(0);
  });
});
