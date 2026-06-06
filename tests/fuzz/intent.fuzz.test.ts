import { describe, expect, test } from 'bun:test';

import { intentHash, normalizeDecimal } from '@/lib/intent/canonical';
import { unsignedIntentSchema } from '@/lib/intent/schema';
import { signIntent } from '@/lib/intent/sign';
import { verifyIntentSignature } from '@/lib/intent/verify';
import { validateIntent } from '@/lib/intent/validate';
import { TEST_PK, TEST_SIGNER, validOpenInput } from '@/tests/fixtures/intent-fixtures';

/**
 * Property/fuzz tests for the Intent boundary. Determinism is controlled with a
 * seeded PRNG so a failure reproduces exactly. Core invariants:
 *  - the validator always returns a typed result and never throws (B1);
 *  - verify(sign(x)) is true and any mutation makes it false;
 *  - canonicalization is invariant to source key order;
 *  - numeric normalization is idempotent and rejects garbage without panic.
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

function randomValue(r: () => number, depth = 0): unknown {
  const kinds = depth > 2 ? 5 : 9;
  switch (Math.floor(r() * kinds)) {
    case 0:
      return null;
    case 1:
      return r() < 0.5;
    case 2:
      return Math.floor((r() - 0.5) * 1e9);
    case 3:
      return (r() - 0.5) * 1e6;
    case 4:
      return pick(r, [
        '',
        'open',
        'transfer',
        'BTC-PERP',
        '0xdead',
        '\u0000\u202e',
        '{}[]',
        '1e9',
        'long',
      ]);
    case 5:
      return [randomValue(r, depth + 1), randomValue(r, depth + 1)];
    case 6:
      return { [pick(r, ['a', 'action', 'size', 'ttl'])]: randomValue(r, depth + 1) };
    case 7:
      return NaN;
    default:
      return undefined;
  }
}

describe('validateIntent never throws on arbitrary input', () => {
  test('structural fuzz → ok or deterministic typed failure', async () => {
    const r = rng(0xc0ffee);
    for (let i = 0; i < 1500; i += 1) {
      const fields = [
        'action',
        'agent_id',
        'market',
        'side',
        'size',
        'leverage',
        'max_slippage',
        'nonce',
        'ttl',
        'signature',
        'target_address',
        'tp',
        'sl',
        'extra',
      ];
      const obj: Record<string, unknown> = {};
      for (const f of fields) {
        if (r() < 0.6) obj[f] = randomValue(r);
      }
      const result = await validateIntent(r() < 0.05 ? randomValue(r) : obj, {
        resolveSigner: () => TEST_SIGNER,
        now: new Date('2030-01-01T00:00:00Z'),
      });
      expect(typeof result.ok).toBe('boolean');
      if (!result.ok) {
        expect(['schema', 'signature', 'nonce', 'ttl', 'bounds', 'target_address']).toContain(
          result.stage,
        );
      }
    }
  });
});

describe('signature round-trip property', () => {
  test('verify(sign(x)) is true; any single-byte mutation flips it to false', async () => {
    const r = rng(0x5eed);
    for (let i = 0; i < 60; i += 1) {
      const signed = await signIntent(
        validOpenInput({
          size: Math.floor(r() * 9000) + 1,
          leverage: Math.floor(r() * 10) + 1,
          max_slippage: Math.round(r() * 100) / 100,
          side: pick(r, ['long', 'short'] as const),
          nonce: String(i),
          ttl: '2030-06-01T00:00:00.000Z',
        }),
        TEST_PK,
      );
      expect(await verifyIntentSignature(signed, TEST_SIGNER)).toBe(true);

      const hex = signed.signature.slice(2).split('');
      const idx = Math.floor(r() * hex.length);
      const orig = hex[idx] as string;
      hex[idx] = orig === '0' ? '1' : '0';
      const mutated = `0x${hex.join('')}` as typeof signed.signature;
      // A mutated signature is either unrecoverable or recovers to a different
      // address — never to the authorized signer.
      expect(await verifyIntentSignature({ ...signed, signature: mutated }, TEST_SIGNER)).toBe(
        false,
      );
    }
  });
});

describe('canonicalization is order-invariant under fuzz', () => {
  test('shuffled key orders yield identical hashes', () => {
    const r = rng(0xabc123);
    for (let i = 0; i < 200; i += 1) {
      const input = validOpenInput({
        size: Math.floor(r() * 5000) + 1,
        nonce: String(i),
        ttl: '2030-01-01T00:00:00.000Z',
      }) as Record<string, unknown>;
      const entries = Object.entries(input);
      for (let j = entries.length - 1; j > 0; j -= 1) {
        const k = Math.floor(r() * (j + 1));
        [entries[j], entries[k]] = [entries[k]!, entries[j]!];
      }
      const shuffled = Object.fromEntries(entries);
      expect(intentHash(unsignedIntentSchema.parse(shuffled))).toBe(
        intentHash(unsignedIntentSchema.parse(input)),
      );
    }
  });
});

describe('normalizeDecimal fuzz', () => {
  test('idempotent on valid decimals; throws (no panic) on garbage', () => {
    const r = rng(0xfeed);
    for (let i = 0; i < 1000; i += 1) {
      const digits = '0123456789';
      let s = r() < 0.5 ? '-' : '';
      const n = Math.floor(r() * 6) + 1;
      for (let j = 0; j < n; j += 1) s += digits[Math.floor(r() * 10)];
      if (r() < 0.5) {
        s += '.';
        const m = Math.floor(r() * 5);
        for (let j = 0; j < m; j += 1) s += digits[Math.floor(r() * 10)];
      }
      const once = normalizeDecimal(s);
      expect(normalizeDecimal(once)).toBe(once);
    }
    for (const garbage of ['', 'x', '1.2.3', '++1', '1e', 'NaN', '0x1', ' 1 2 ']) {
      expect(() => normalizeDecimal(garbage)).toThrow();
    }
  });
});
