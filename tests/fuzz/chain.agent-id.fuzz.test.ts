import { describe, expect, test } from 'bun:test';

import {
  deriveAgentIdOnchain,
  formatAgentIdOnchain,
  parseAgentIdOnchain,
} from '@/lib/chain/agent-id';

/**
 * Fuzz tests for agent-id provenance.
 *
 * Verifies collision resistance, round-trip stability, and boundary behaviors
 * of the deterministic agent ID derivation.
 */

function randomAddress(): `0x${string}` {
  const arr = new Uint8Array(20);
  crypto.getRandomValues(arr);
  return ('0x' + [...arr].map((b) => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
}

function randomString(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789-_';
  let s = '';
  for (let i = 0; i < len; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

const FUZZ_ROUNDS = 50;

describe('deriveAgentIdOnchain collision resistance', () => {
  test('no collisions across random (stableId, address) pairs', () => {
    const seen = new Set<string>();
    for (let i = 0; i < FUZZ_ROUNDS; i++) {
      const id = deriveAgentIdOnchain(randomString(8 + Math.floor(Math.random() * 20)), randomAddress());
      const hex = id.toString(16);
      expect(seen.has(hex)).toBe(false);
      seen.add(hex);
    }
  });

  test('no collisions for sequential agent names with same operator', () => {
    const operator = randomAddress();
    const seen = new Set<string>();
    for (let i = 0; i < FUZZ_ROUNDS; i++) {
      const id = deriveAgentIdOnchain(`agent-${i}`, operator);
      const hex = id.toString(16);
      expect(seen.has(hex)).toBe(false);
      seen.add(hex);
    }
  });

  test('all results are in uint256 range', () => {
    for (let i = 0; i < FUZZ_ROUNDS; i++) {
      const id = deriveAgentIdOnchain(randomString(10), randomAddress());
      expect(id).toBeGreaterThanOrEqual(0n);
      expect(id).toBeLessThan(2n ** 256n);
    }
  });
});

describe('format/parse round-trip fuzz', () => {
  test('round-trips for random bigints', () => {
    for (let i = 0; i < FUZZ_ROUNDS; i++) {
      const arr = new Uint8Array(32);
      crypto.getRandomValues(arr);
      const original = BigInt('0x' + [...arr].map((b) => b.toString(16).padStart(2, '0')).join(''));
      const formatted = formatAgentIdOnchain(original);
      const parsed = parseAgentIdOnchain(formatted);
      expect(parsed).toBe(original);
    }
  });

  test('round-trips for zero', () => {
    expect(parseAgentIdOnchain(formatAgentIdOnchain(0n))).toBe(0n);
  });

  test('round-trips for max uint256', () => {
    const max = 2n ** 256n - 1n;
    expect(parseAgentIdOnchain(formatAgentIdOnchain(max))).toBe(max);
  });

  test('format always produces exactly 66-char output', () => {
    for (let i = 0; i < FUZZ_ROUNDS; i++) {
      const arr = new Uint8Array(32);
      crypto.getRandomValues(arr);
      const val = BigInt('0x' + [...arr].map((b) => b.toString(16).padStart(2, '0')).join(''));
      const formatted = formatAgentIdOnchain(val);
      expect(formatted.length).toBe(66); // 0x + 64
    }
  });
});

describe('parseAgentIdOnchain edge cases', () => {
  test('rejects empty string', () => {
    expect(() => parseAgentIdOnchain('')).toThrow();
  });

  test('rejects plain decimal number', () => {
    expect(() => parseAgentIdOnchain('12345')).toThrow();
  });

  test('rejects random alphanumeric strings', () => {
    for (let i = 0; i < 10; i++) {
      const s = randomString(20);
      if (!s.startsWith('0x') && !s.startsWith('0X')) {
        expect(() => parseAgentIdOnchain(s)).toThrow();
      }
    }
  });

  test('accepts 0x prefix with various lengths', () => {
    expect(parseAgentIdOnchain('0x0')).toBe(0n);
    expect(parseAgentIdOnchain('0xff')).toBe(255n);
    expect(parseAgentIdOnchain('0x100')).toBe(256n);
  });
});
