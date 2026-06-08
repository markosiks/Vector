import { describe, expect, test } from 'bun:test';
import { keccak256, toBytes } from 'viem';

import { verifyDetailHash } from '@/lib/attestation/build';
import { mirrorAttestation, type MirrorFacts } from '@/lib/attestation/pipeline';
import type { OutcomeRow, PolicyEventRow } from '@/lib/db/schema';
import type { ScoreInputs, ScoreResult } from '@/lib/scoring/types';

import { FakeAttestationDb } from '../fixtures/attestation-db';

/**
 * The in-transaction mirror is the exactly-one-per-round artifact written atomically
 * with the score. These pin: it encodes value/tags + builds an integrity-verifiable
 * detail, it derives the outcome class from the round facts, and a double settle
 * yields one row (idempotent), never two.
 */

const AGENT = '11111111-1111-1111-1111-111111111111';
const ROUND = '22222222-2222-2222-2222-222222222222';

function result(over: Partial<ScoreResult> = {}): ScoreResult {
  return {
    raw_r: '70.000',
    score_r: '73.500',
    crashed: false,
    components: { perf: 0.5, w: 0.25, policy: 0.9, dd: 0.05 },
    ...over,
  };
}

function inputs(over: Partial<ScoreInputs> = {}): ScoreInputs {
  return {
    pnl_r: 120,
    car_r: 3000,
    soft: 1,
    hard: 0,
    halt: 0,
    dd_r: 0.05,
    drain_r: false,
    ...over,
  };
}

function outcome(): OutcomeRow {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    execution_id: null,
    agent_id: AGENT,
    round_id: ROUND,
    pnl_realized: '100',
    pnl_marked: '20',
    capital_at_risk: '1000',
    fees: '0.25',
    position_delta: '-2',
    drawdown: '0.05',
    created_at: new Date('2026-06-06T00:00:00Z'),
  };
}

function event(): PolicyEventRow {
  return {
    id: '44444444-4444-4444-4444-444444444444',
    intent_id: '55555555-5555-5555-5555-555555555555',
    agent_id: AGENT,
    round_id: ROUND,
    rule_fired: 'size_cap',
    decision: 'CLIP',
    severity: 'soft',
    detail_json: null,
    created_at: new Date('2026-06-06T00:00:00Z'),
  };
}

function facts(over: Partial<MirrorFacts> = {}): MirrorFacts {
  return {
    agent: { seedId: 'seed-leader', uuid: AGENT, onchainId: '7' },
    roundId: ROUND,
    result: result(),
    inputs: inputs(),
    outcomes: [outcome()],
    policyEvents: [event()],
    ...over,
  };
}

describe('mirrorAttestation', () => {
  test('writes an optimistic row with the encoded value, tags, and a verifiable detail', async () => {
    const db = new FakeAttestationDb([], ['0xabc', '0xdef']);
    const { attestation, created } = await mirrorAttestation(db, facts());

    expect(created).toBe(true);
    expect(attestation.value).toBe('74'); // round(73.5)
    expect(attestation.value_decimals).toBe(0);
    expect(attestation.tag1).toBe(ROUND);
    expect(attestation.tag2).toBe('violation'); // soft=1, no halt/crash
    expect(attestation.chain_state).toBe('optimistic');
    expect(attestation.feedback_detail).not.toBeNull();
    // The stored bytes hash to the stored on-chain hash (integrity invariant).
    expect(attestation.feedback_hash).toBe(
      keccak256(toBytes(attestation.feedback_detail as string)),
    );
    expect(
      verifyDetailHash(attestation.feedback_detail as string, attestation.feedback_hash as string),
    ).toBe(true);
  });

  test('derives the halt class from a floor-crash', async () => {
    const db = new FakeAttestationDb([], []);
    const { attestation } = await mirrorAttestation(
      db,
      facts({ result: result({ crashed: true }), inputs: inputs({ hard: 1, drain_r: true }) }),
    );
    expect(attestation.tag2).toBe('halt');
  });

  test('is idempotent: a double settle yields one row, returning the existing on conflict', async () => {
    const db = new FakeAttestationDb([], ['0xabc']);
    const first = await mirrorAttestation(db, facts());
    const second = await mirrorAttestation(db, facts());

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.attestation.id).toBe(first.attestation.id);
    expect(db.all()).toHaveLength(1);
  });
});
