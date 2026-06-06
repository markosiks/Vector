import { describe, expect, test } from 'bun:test';

import {
  canonicalPayload,
  intentHash,
  normalizeDecimal,
  normalizeNonce,
  normalizeTimestamp,
  stableStringify,
} from '@/lib/intent/canonical';
import { unsignedIntentSchema } from '@/lib/intent/schema';
import { validOpenInput } from '@/tests/fixtures/intent-fixtures';

describe('normalizeDecimal', () => {
  test('collapses equivalent representations to one canonical string', () => {
    for (const [input, expected] of [
      [1, '1'],
      [1.0, '1'],
      ['1', '1'],
      ['1.0', '1'],
      ['01', '1'],
      ['1.500', '1.5'],
      ['.5', '0.5'],
      ['5.', '5'],
      ['000.000', '0'],
      [0, '0'],
      [-0, '0'],
      ['-0', '0'],
      ['-0.0', '0'],
      ['1e3', '1000'],
      ['1.5e2', '150'],
      ['1E-3', '0.001'],
      ['-12.34', '-12.34'],
      [1e21, '1000000000000000000000'],
      [0.0000001, '0.0000001'],
    ] as const) {
      expect(normalizeDecimal(input)).toBe(expected);
    }
  });

  test('is idempotent', () => {
    for (const v of ['1.500', '1e3', '.5', '-0.0', '0.0000001']) {
      expect(normalizeDecimal(normalizeDecimal(v))).toBe(normalizeDecimal(v));
    }
  });

  test('rejects non-finite numbers and non-decimal strings', () => {
    for (const bad of [
      NaN,
      Infinity,
      -Infinity,
      '',
      '   ',
      'abc',
      '1.2.3',
      '0x10',
      '1,000',
      '--1',
      '1e',
    ] as const) {
      expect(() => normalizeDecimal(bad as number | string)).toThrow();
    }
  });

  test('rejects literals beyond the precision cap', () => {
    expect(() => normalizeDecimal('1'.repeat(81))).toThrow();
  });

  test('rejects exponent-driven expansion without allocating (DoS guard)', () => {
    // A handful of input bytes must never expand to a multi-MB string. The
    // check is bound-then-reject, so each call returns in O(1), not O(10^exp).
    for (const bomb of ['1e8000000', '1e-8000000', '1e999999999', '1e-999999999']) {
      const started = Date.now();
      expect(() => normalizeDecimal(bomb)).toThrow(/maximum precision/);
      expect(Date.now() - started).toBeLessThan(100);
    }
    // The magnitude cap is at the same boundary as the digit cap: 1e79 is the
    // largest power of ten that fits, 1e80 does not.
    expect(normalizeDecimal('1e79')).toBe('1' + '0'.repeat(79));
    expect(() => normalizeDecimal('1e80')).toThrow(/maximum precision/);
  });
});

describe('normalizeNonce', () => {
  test('normalizes integers and strings to identical tokens', () => {
    expect(normalizeNonce(1)).toBe('1');
    expect(normalizeNonce('1')).toBe('1');
    expect(normalizeNonce('abc-123')).toBe('abc-123');
  });

  test('rejects empty strings and non-integer numbers', () => {
    expect(() => normalizeNonce('')).toThrow();
    expect(() => normalizeNonce(1.5)).toThrow();
    expect(() => normalizeNonce(NaN)).toThrow();
  });

  test('rejects numeric nonces beyond the safe-integer range (anti-aliasing)', () => {
    // 2^53 and 2^53+1 are indistinguishable as IEEE-754 doubles; accepting them
    // would alias two distinct nonces to one canonical token. A string nonce is
    // the supported escape hatch for large/opaque values.
    expect(Number.MAX_SAFE_INTEGER + 1).toBe(Number.MAX_SAFE_INTEGER + 2); // precision is already lost
    expect(() => normalizeNonce(Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe-integer/);
    expect(() => normalizeNonce(1e21)).toThrow(/safe-integer/);
    expect(normalizeNonce(Number.MAX_SAFE_INTEGER)).toBe(String(Number.MAX_SAFE_INTEGER));
    // a string nonce of the same magnitude is preserved verbatim
    expect(normalizeNonce('9007199254740993')).toBe('9007199254740993');
  });
});

describe('normalizeTimestamp', () => {
  test('normalizes ISO strings and epoch-ms to ISO-8601 UTC', () => {
    const iso = '2030-01-01T00:00:00.000Z';
    expect(normalizeTimestamp(iso)).toBe(iso);
    expect(normalizeTimestamp(Date.parse(iso))).toBe(iso);
    expect(normalizeTimestamp('2030-01-01T01:00:00+01:00')).toBe(iso);
  });

  test('rejects unparseable timestamps', () => {
    expect(() => normalizeTimestamp('not-a-date')).toThrow();
    expect(() => normalizeTimestamp(NaN)).toThrow();
  });

  test('rejects ambiguous / non-deterministic string forms', () => {
    // Timezone-less datetime: ECMA-262 parses this in the host's *local* zone,
    // so the canonical bytes would depend on the server's TZ. Must be rejected.
    expect(() => normalizeTimestamp('2030-01-01T00:00:00')).toThrow(/timezone/);
    // Implementation-defined / non-ISO strings that lenient `Date` would accept.
    expect(() => normalizeTimestamp('2031')).toThrow();
    expect(() => normalizeTimestamp('Jan 1 2030')).toThrow();
    expect(() => normalizeTimestamp('01/02/2030')).toThrow();
    // A digit string is NOT silently reinterpreted as a year/epoch.
    expect(() => normalizeTimestamp('1700000000000')).toThrow();
    // Out-of-range fields in an otherwise well-formed instant still reject.
    expect(() => normalizeTimestamp('2030-13-45T00:00:00Z')).toThrow();
  });

  test('accepts strict ISO-8601 instants with Z or numeric offset', () => {
    expect(normalizeTimestamp('2030-01-01T00:00:00Z')).toBe('2030-01-01T00:00:00.000Z');
    expect(normalizeTimestamp('2030-01-01T00:00:00.000Z')).toBe('2030-01-01T00:00:00.000Z');
    expect(normalizeTimestamp('2030-01-01T01:00:00+01:00')).toBe('2030-01-01T00:00:00.000Z');
    expect(normalizeTimestamp('2030-01-01T01:00:00+0100')).toBe('2030-01-01T00:00:00.000Z');
  });
});

describe('stableStringify', () => {
  test('sorts keys at every depth and omits undefined', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify({ a: { d: 1, c: 2 }, b: 3 })).toBe('{"a":{"c":2,"d":1},"b":3}');
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  test('serializes arrays (undefined elements become null) and primitives', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
    expect(stableStringify([1, undefined, 2])).toBe('[1,null,2]');
    expect(stableStringify('x')).toBe('"x"');
    expect(stableStringify(null)).toBe('null');
  });
});

describe('canonicalPayload', () => {
  test('is invariant to source key order', () => {
    const a = unsignedIntentSchema.parse(validOpenInput({ nonce: '7' }));
    const b = unsignedIntentSchema.parse({
      ttl: a.ttl,
      nonce: '7',
      side: 'long',
      action: 'open',
      market: 'BTC-PERP',
      leverage: 3,
      size: 1000,
      max_slippage: 0.01,
      agent_id: 'agent-001',
    });
    expect(canonicalPayload(a)).toBe(canonicalPayload(b));
    expect(intentHash(a)).toBe(intentHash(b));
  });

  test('numeric representations 1 vs 1.0 vs "1" hash identically', () => {
    const h = (size: number | string) =>
      intentHash(
        unsignedIntentSchema.parse(
          validOpenInput({ size, nonce: '9', ttl: '2030-01-01T00:00:00.000Z' }),
        ),
      );
    expect(h(1)).toBe(h('1'));
    expect(h(1.0)).toBe(h('1.0'));
    expect(h(1)).toBe(h('1.0'));
  });

  test('omits absent optional fields rather than serializing null', () => {
    const payload = canonicalPayload(unsignedIntentSchema.parse(validOpenInput()));
    expect(payload).not.toContain('tp');
    expect(payload).not.toContain('null');
  });

  test('a different field value changes the hash', () => {
    const base = unsignedIntentSchema.parse(
      validOpenInput({ size: 1000, nonce: '1', ttl: '2030-01-01T00:00:00.000Z' }),
    );
    const diff = unsignedIntentSchema.parse(
      validOpenInput({ size: 1001, nonce: '1', ttl: '2030-01-01T00:00:00.000Z' }),
    );
    expect(intentHash(base)).not.toBe(intentHash(diff));
  });
});
