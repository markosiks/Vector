import { describe, expect, test } from 'bun:test';

import { parseEnvelope, ByrealParseError } from '@/lib/rail/byreal/envelope';
import { parseOrderResult } from '@/lib/rail/byreal/parse';
import { buildSettlementCommand, ByrealCommandError } from '@/lib/rail/byreal/command';
import type { Intent } from '@/lib/intent/types';

/**
 * Property/fuzz tests for the Byreal rail's untrusted boundaries (P2.1).
 * Determinism is controlled with a seeded PRNG so a failure reproduces exactly.
 * Invariants:
 *  - `parseEnvelope` either returns a valid envelope or throws `ByrealParseError`
 *    — it never panics with a different error or returns a malformed value;
 *  - a built command argv never contains a shell-control byte, no matter the
 *    numeric input (it is either rejected or a clean decimal);
 *  - `buildSettlementCommand` never throws on a structurally-valid Intent except
 *    the deterministic `ByrealCommandError` for a malformed numeric.
 */

/** mulberry32 — small deterministic PRNG. */
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

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;

function randomString(r: () => number): string {
  const alphabet = ' {}[]":,\\\u001b\ntrue0123456789.-success$();`&|';
  let s = '';
  const len = Math.floor(r() * 40);
  for (let i = 0; i < len; i += 1) s += alphabet[Math.floor(r() * alphabet.length)];
  return s;
}

describe('parseEnvelope never panics on arbitrary stdout', () => {
  test('returns a valid envelope or throws ByrealParseError — nothing else', () => {
    const r = rng(0xb17ea1);
    for (let i = 0; i < 5_000; i += 1) {
      const noise = randomString(r);
      // Sometimes wrap a real envelope in noise; sometimes pure garbage.
      const input =
        r() < 0.3
          ? `${noise}${JSON.stringify({ success: r() < 0.5, data: { n: i } })}${noise}`
          : noise;
      try {
        const env = parseEnvelope(input);
        expect(typeof env.success).toBe('boolean');
      } catch (err) {
        expect(err).toBeInstanceOf(ByrealParseError);
      }
    }
  });
});

describe('parseOrderResult is total on arbitrary objects', () => {
  test('returns an OrderFill or throws ByrealParseError', () => {
    const r = rng(0x0d3e);
    for (let i = 0; i < 3_000; i += 1) {
      const data: Record<string, unknown> = {};
      if (r() < 0.7) data.oid = r() < 0.5 ? Math.floor(r() * 1e6) : randomString(r);
      if (r() < 0.5) data.filled = { totalSz: randomString(r), avgPx: randomString(r) };
      if (r() < 0.3) data.fee = randomString(r);
      try {
        const fill = parseOrderResult(data);
        expect(typeof fill.orderId).toBe('string');
        expect(['sent', 'filled', 'partial', 'error']).toContain(fill.status);
        // Economics always normalize to a decimal string (default '0').
        expect(fill.fees).toMatch(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
      } catch (err) {
        expect(err).toBeInstanceOf(ByrealParseError);
      }
    }
  });
});

describe('command argv is always shell-safe', () => {
  const base: Intent = {
    agent_id: 'a',
    action: 'open',
    market: 'BTC-PERP',
    side: 'long',
    size: '0.01',
    leverage: '2',
    max_slippage: '0.01',
    nonce: '1',
    ttl: '60',
    signature: `0x${'1'.repeat(130)}`,
  } as Intent;

  test('a built argv never carries a shell-control byte; bad numerics are rejected', () => {
    const r = rng(0xfa11);
    const dangerous = /[;&|`$(){}<>\n\r*?~!#]/;
    for (let i = 0; i < 3_000; i += 1) {
      const size = r() < 0.5 ? (r() * 1000).toFixed(Math.floor(r() * 6)) : randomString(r);
      const action = pick(r, ['open', 'close', 'modify'] as const);
      const intent = { ...base, action, size } as Intent;
      try {
        const cmd = buildSettlementCommand(intent);
        if (cmd === null) continue;
        // The coin only ever comes from the frozen whitelist; numerics are decimals.
        for (const arg of cmd.argv) expect(dangerous.test(arg)).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(ByrealCommandError);
      }
    }
  });
});
