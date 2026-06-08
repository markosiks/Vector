import { describe, expect, test } from 'bun:test';

import {
  AttestationEncodeError,
  INT128_MAX,
  INT128_MIN,
  OUTCOME_CLASS,
  deriveOutcomeClass,
  encodeScoreValue,
} from '@/lib/attestation/encode';
import { buildAttestationDetail, canonicalJson, verifyDetailHash } from '@/lib/attestation/build';
import type { OutcomeRow, PolicyEventRow } from '@/lib/db/schema';

/**
 * Property fuzzing for the pure attestation core (§10). A deterministic PRNG
 * drives wide-range inputs so the run is reproducible. Every untrusted input
 * maps to a deterministic outcome — a value or a *typed* rejection — never an
 * untyped throw, NaN, or out-of-range write.
 */

/** Deterministic mulberry32 PRNG — seeded so the fuzz run is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Map a uniform [0,1) to a signed, heavy-tailed magnitude spanning ~[-1e9, 1e9]. */
function spread(u: number): number {
  const sign = u < 0.5 ? -1 : 1;
  const m = Math.abs(u - 0.5) * 2;
  return sign * 10 ** (m * 9);
}

describe('encodeScoreValue fuzz — total over finite, fail-closed on the rest', () => {
  test('every finite draw yields an int in [0,100] inside int128; non-finite is typed-rejected', () => {
    const r = rng(0x5eed);
    for (let i = 0; i < 5000; i += 1) {
      const x = spread(r());
      const v = encodeScoreValue(x);
      expect(v).toBeGreaterThanOrEqual(0n);
      expect(v).toBeLessThanOrEqual(100n);
      expect(v).toBeGreaterThanOrEqual(INT128_MIN);
      expect(v).toBeLessThanOrEqual(INT128_MAX);
    }
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      'x',
      'NaN',
    ]) {
      expect(() => encodeScoreValue(bad as never)).toThrow(AttestationEncodeError);
    }
  });
});

describe('deriveOutcomeClass fuzz — total over valid counts, typed-reject otherwise', () => {
  test('always returns a known class for non-negative integer counts', () => {
    const r = rng(0xc0ffee);
    for (let i = 0; i < 3000; i += 1) {
      const out = deriveOutcomeClass({
        soft: Math.floor(r() * 5),
        hard: Math.floor(r() * 5),
        halt: Math.floor(r() * 3),
        crashed: r() < 0.3,
      });
      expect(OUTCOME_CLASS).toContain(out);
    }
  });

  test('rejects a negative or fractional count rather than guessing', () => {
    expect(() => deriveOutcomeClass({ soft: -1, hard: 0, halt: 0, crashed: false })).toThrow(
      AttestationEncodeError,
    );
    expect(() => deriveOutcomeClass({ soft: 0, hard: 0.5, halt: 0, crashed: false })).toThrow(
      AttestationEncodeError,
    );
  });
});

describe('canonicalJson fuzz — deterministic and key-order invariant', () => {
  test('serialization is invariant to object key insertion order', () => {
    const r = rng(0x1234);
    for (let i = 0; i < 2000; i += 1) {
      const a = r();
      const b = r();
      const c = r();
      const forward = canonicalJson({ a, b, nested: { x: c, y: b }, list: [a, b, c] });
      const shuffled = canonicalJson({ list: [a, b, c], nested: { y: b, x: c }, b, a });
      expect(forward).toBe(shuffled);
    }
  });

  test('rejects a bigint instead of silently changing the bytes', () => {
    expect(() => canonicalJson({ v: 5n })).toThrow(TypeError);
  });
});

describe('buildAttestationDetail / verifyDetailHash fuzz — integrity round-trips', () => {
  function outcome(seed: number): OutcomeRow {
    const r = rng(seed);
    return {
      id: '33333333-3333-3333-3333-333333333333',
      execution_id: null,
      agent_id: '11111111-1111-1111-1111-111111111111',
      round_id: '22222222-2222-2222-2222-222222222222',
      pnl_realized: spread(r()).toFixed(6),
      pnl_marked: spread(r()).toFixed(6),
      capital_at_risk: Math.abs(spread(r())).toFixed(6),
      fees: Math.abs(spread(r())).toFixed(6),
      position_delta: spread(r()).toFixed(0),
      drawdown: r().toFixed(6),
      created_at: new Date('2026-06-06T00:00:00Z'),
    };
  }

  test('built bytes always re-hash to the built hash; verify never throws', () => {
    const r = rng(0xfee1);
    for (let i = 0; i < 1000; i += 1) {
      const events: PolicyEventRow[] = [];
      const built = buildAttestationDetail({
        agent: { seedId: 's', uuid: '11111111-1111-1111-1111-111111111111', onchainId: null },
        roundId: '22222222-2222-2222-2222-222222222222',
        score: {
          scoreR: (r() * 100).toFixed(3),
          rawR: (r() * 100).toFixed(3),
          components: { perf: r(), w: r(), policy: r(), dd: r() },
        },
        outcomeClass: 'clean',
        aggregates: {
          pnl_r: spread(r()),
          car_r: Math.abs(spread(r())),
          dd_r: r(),
          soft: 0,
          hard: 0,
          halt: 0,
          drain: false,
        },
        outcomes: [outcome(i)],
        policyEvents: events,
        intentHashes: [`0x${(i % 16).toString(16).repeat(64)}`.slice(0, 66)],
        feedback: {
          value: BigInt(Math.floor(r() * 101)),
          valueDecimals: 0,
          tag1: 't',
          tag2: 'clean',
        },
      });
      expect(verifyDetailHash(built.json, built.hash)).toBe(true);
      // Any perturbation of the served bytes is detected.
      expect(verifyDetailHash(`${built.json} `, built.hash)).toBe(false);
    }
  });

  test('verifyDetailHash returns false (never throws) on arbitrary garbage', () => {
    const inputs: [unknown, unknown][] = [
      ['', ''],
      ['{}', '0x'],
      ['not json', 'zzz'],
      [undefined, null],
      [42, {}],
    ];
    for (const [a, b] of inputs) {
      expect(verifyDetailHash(a as never, b as never)).toBe(false);
    }
  });
});
