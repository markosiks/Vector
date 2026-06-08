import { describe, expect, test } from 'bun:test';

import {
  AttestationEncodeError,
  INT128_MAX,
  INT128_MIN,
  VALUE_DECIMALS,
  deriveOutcomeClass,
  encodeFeedback,
  encodeScoreValue,
  type OutcomeClassInputs,
} from '@/lib/attestation/encode';

/**
 * The pure encoder is the deterministic core of the attestation payload. These
 * cover the documented contracts: the absolute-score → `int128` mapping (round
 * half-up, clamped `[0,100]`, total over finite input), the outcome-class
 * precedence (`halt` ≻ `violation` ≻ `clean`), and the tag bindings.
 */

const NO_VIOLATIONS: OutcomeClassInputs = { soft: 0, hard: 0, halt: 0, crashed: false };

describe('encodeScoreValue', () => {
  test('rounds an AgentScore to an integer in [0,100] with valueDecimals 0', () => {
    expect(encodeScoreValue('73.500')).toBe(74n); // half rounds up
    expect(encodeScoreValue('73.499')).toBe(73n);
    expect(encodeScoreValue(0)).toBe(0n);
    expect(encodeScoreValue('100.000')).toBe(100n);
    expect(VALUE_DECIMALS).toBe(0);
  });

  test('clamps an out-of-range score into the [0,100] codomain (never writes out of range)', () => {
    expect(encodeScoreValue(-5)).toBe(0n);
    expect(encodeScoreValue('250')).toBe(100n);
  });

  test('rejects a non-finite score rather than emitting a silent 0', () => {
    expect(() => encodeScoreValue('not-a-number')).toThrow(AttestationEncodeError);
    expect(() => encodeScoreValue(Number.NaN)).toThrow(AttestationEncodeError);
    expect(() => encodeScoreValue(Number.POSITIVE_INFINITY)).toThrow(AttestationEncodeError);
  });

  test('the encoded value sits well inside the int128 bounds', () => {
    const v = encodeScoreValue('100');
    expect(v).toBeLessThanOrEqual(INT128_MAX);
    expect(v).toBeGreaterThanOrEqual(INT128_MIN);
  });
});

describe('deriveOutcomeClass', () => {
  test('clean when there is no violation and no crash', () => {
    expect(deriveOutcomeClass(NO_VIOLATIONS)).toBe('clean');
  });

  test('violation when any hard or soft violation occurred', () => {
    expect(deriveOutcomeClass({ ...NO_VIOLATIONS, soft: 1 })).toBe('violation');
    expect(deriveOutcomeClass({ ...NO_VIOLATIONS, hard: 2 })).toBe('violation');
  });

  test('halt dominates: a halt event or a floor-crash classifies as halt', () => {
    expect(deriveOutcomeClass({ ...NO_VIOLATIONS, halt: 1 })).toBe('halt');
    // A drain crashes the round (scorer `crashed`) even with no explicit halt
    // event and is still classified halt, never under-reported as violation.
    expect(deriveOutcomeClass({ soft: 0, hard: 1, halt: 0, crashed: true })).toBe('halt');
  });

  test('rejects a negative or non-integer count', () => {
    expect(() => deriveOutcomeClass({ ...NO_VIOLATIONS, soft: -1 })).toThrow(
      AttestationEncodeError,
    );
    expect(() => deriveOutcomeClass({ ...NO_VIOLATIONS, hard: 1.5 })).toThrow(
      AttestationEncodeError,
    );
  });
});

describe('encodeFeedback', () => {
  test('binds tag1 to the round id and tag2 to the outcome class', () => {
    const out = encodeFeedback({ scoreR: '88.4', roundId: 'round-7', outcomeClass: 'violation' });
    expect(out).toEqual({ value: 88n, valueDecimals: 0, tag1: 'round-7', tag2: 'violation' });
  });

  test('rejects an unknown outcome class', () => {
    expect(() =>
      encodeFeedback({ scoreR: '50', roundId: 'r', outcomeClass: 'boom' as never }),
    ).toThrow(AttestationEncodeError);
  });

  test('rejects an empty round id', () => {
    expect(() => encodeFeedback({ scoreR: '50', roundId: '', outcomeClass: 'clean' })).toThrow(
      AttestationEncodeError,
    );
  });
});
