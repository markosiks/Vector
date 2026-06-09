import { describe, expect, test } from 'bun:test';

import { ELFA_TRENDING_PATH } from '@/lib/signals/elfa/client';
import { buildElfaMock } from '@/lib/signals/elfa/mock';

/**
 * Unit: the deterministic seeded mock. It is the always-present fail-open
 * baseline, so its two load-bearing properties are: it is *byte-stable* across
 * calls (no clock, no randomness) and it is well-formed (every sentiment a finite
 * numeric string, `origin: 'mock'`).
 */

describe('elfa mock — determinism & shape', () => {
  test('is byte-identical across calls (no wall-clock, no randomness)', () => {
    expect(buildElfaMock()).toEqual(buildElfaMock());
  });

  test('uses a fixed seeded fetchedAtMs, never Date.now()', () => {
    const before = Date.now();
    const m = buildElfaMock();
    // A real clock would land near `before`; the seeded sentinel is far from it.
    expect(m.fetchedAtMs).toBe(1_700_000_000_000);
    expect(Math.abs(m.fetchedAtMs - before)).toBeGreaterThan(1_000_000);
  });

  test('is a well-formed mock snapshot with finite numeric sentiments', () => {
    const m = buildElfaMock();
    expect(m.source).toBe('elfa');
    expect(m.origin).toBe('mock');
    expect(m.endpoint).toBe(ELFA_TRENDING_PATH);
    expect(m.sentiments.length).toBeGreaterThan(0);
    for (const s of m.sentiments) {
      expect(typeof s.sentiment).toBe('string');
      expect(Number.isFinite(Number(s.sentiment))).toBe(true);
    }
  });

  test('returns a fresh object each call so a caller cannot mutate shared state', () => {
    const a = buildElfaMock();
    const b = buildElfaMock();
    expect(a).not.toBe(b);
    expect(a.sentiments).not.toBe(b.sentiments);
  });

  test('is deeply frozen: the snapshot, the sentiments array, and each row are immutable', () => {
    const m = buildElfaMock();
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m.sentiments)).toBe(true);
    for (const s of m.sentiments) expect(Object.isFrozen(s)).toBe(true);
    // A runtime mutation that bypasses the readonly type must not corrupt the
    // shared snapshot (the provider returns this same reference forever).
    expect(() => {
      (m.sentiments as unknown as Array<unknown>).push({ symbol: 'EVIL', sentiment: '999' });
    }).toThrow();
    expect(m.sentiments.length).toBe(buildElfaMock().sentiments.length);
  });
});
