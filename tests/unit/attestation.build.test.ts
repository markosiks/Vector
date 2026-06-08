import { describe, expect, test } from 'bun:test';
import { keccak256, toBytes } from 'viem';

import {
  ATTESTATION_DETAIL_SCHEMA,
  buildAttestationDetail,
  canonicalJson,
  verifyDetailHash,
  type AttestationDetailFacts,
} from '@/lib/attestation/build';
import type { EncodedFeedback } from '@/lib/attestation/encode';
import type { OutcomeRow, PolicyEventRow } from '@/lib/db/schema';

/**
 * The detail builder anchors an off-chain document on-chain. The integrity
 * contract is the load-bearing property: the **exact stored bytes** hash to the
 * `feedbackHash`, deterministically and order-insensitively in object keys.
 */

const AGENT = '11111111-1111-1111-1111-111111111111';
const ROUND = '22222222-2222-2222-2222-222222222222';

const FEEDBACK: EncodedFeedback = {
  value: 74n,
  valueDecimals: 0,
  tag1: ROUND,
  tag2: 'violation',
};

function outcome(over: Partial<OutcomeRow> = {}): OutcomeRow {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    execution_id: null,
    agent_id: AGENT,
    round_id: ROUND,
    pnl_realized: '100',
    pnl_marked: '50',
    capital_at_risk: '1000',
    fees: '0.25',
    position_delta: '-2',
    drawdown: '0.05',
    created_at: new Date('2026-06-06T00:00:00Z'),
    ...over,
  };
}

function event(over: Partial<PolicyEventRow> = {}): PolicyEventRow {
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
    ...over,
  };
}

function facts(over: Partial<AttestationDetailFacts> = {}): AttestationDetailFacts {
  return {
    agent: { seedId: 'seed-leader', uuid: AGENT, onchainId: null },
    roundId: ROUND,
    score: {
      scoreR: '73.500',
      rawR: '70.000',
      components: { perf: 0.5, w: 0.25, policy: 0.9, dd: 0.05 },
    },
    outcomeClass: 'violation',
    aggregates: { pnl_r: 120, car_r: 3000, dd_r: 0.05, soft: 1, hard: 0, halt: 0, drain: false },
    outcomes: [outcome()],
    policyEvents: [event()],
    intentHashes: ['0xabc', '0xdef'],
    feedback: FEEDBACK,
    ...over,
  };
}

describe('canonicalJson', () => {
  test('sorts object keys at every depth and drops incidental whitespace', () => {
    const a = canonicalJson({ b: 1, a: { d: 4, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 4 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  test('preserves array order (arrays are values, not sets)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  test('serializes primitives and null', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(true)).toBe('true');
  });

  test('rejects a bigint rather than silently changing the bytes', () => {
    expect(() => canonicalJson({ v: 1n })).toThrow(TypeError);
  });
});

describe('buildAttestationDetail', () => {
  test('the hash is keccak256 of the exact json bytes it returns', () => {
    const built = buildAttestationDetail(facts());
    expect(built.hash).toBe(keccak256(toBytes(built.json)));
    expect(built.json).toBe(canonicalJson(built.detail));
  });

  test('carries the schema tag, the integer value as a string, and the round id', () => {
    const built = buildAttestationDetail(facts());
    expect(built.detail.schema).toBe(ATTESTATION_DETAIL_SCHEMA);
    expect(built.detail.round_id).toBe(ROUND);
    expect((built.detail.feedback as { value: string }).value).toBe('74');
  });

  test('is deterministic: identical facts produce an identical hash', () => {
    expect(buildAttestationDetail(facts()).hash).toBe(buildAttestationDetail(facts()).hash);
  });

  test('is sensitive: a changed fact changes the hash', () => {
    const base = buildAttestationDetail(facts()).hash;
    const moved = buildAttestationDetail(facts({ feedback: { ...FEEDBACK, value: 75n } })).hash;
    expect(moved).not.toBe(base);
  });
});

describe('verifyDetailHash', () => {
  test('accepts the matching bytes, case-insensitively', () => {
    const built = buildAttestationDetail(facts());
    expect(verifyDetailHash(built.json, built.hash)).toBe(true);
    expect(verifyDetailHash(built.json, built.hash.toUpperCase())).toBe(true);
  });

  test('rejects tampered or stale bytes', () => {
    const built = buildAttestationDetail(facts());
    expect(verifyDetailHash(`${built.json} `, built.hash)).toBe(false);
  });

  test('returns false (never throws) on malformed input', () => {
    expect(verifyDetailHash('not json but still bytes', '0xnothex')).toBe(false);
    expect(verifyDetailHash(undefined as never, undefined as never)).toBe(false);
  });
});
