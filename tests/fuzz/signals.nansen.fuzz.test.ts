import { describe, expect, test } from 'bun:test';

import { createNansenClient, NansenClientError } from '@/lib/signals/nansen/client';
import { createNansenSignalProvider } from '@/lib/signals/nansen/provider';
import type { NansenClient } from '@/lib/signals/nansen/client';
import type { NansenSignal } from '@/lib/signals/nansen/types';

/**
 * Property/fuzz tests for the Nansen signal's untrusted boundaries (P2.2).
 * Determinism is controlled with a seeded PRNG so a failure reproduces exactly.
 * Invariants:
 *  - `fetchSignal` over an *arbitrary* HTTP body either resolves with a
 *    well-formed {@link NansenSignal} (bounded rows, every `netflowUsd` a finite
 *    numeric string) or rejects with a {@link NansenClientError} — never panics
 *    with a foreign error and never yields `NaN`/`Infinity`/oversized output;
 *  - the provider, driven by arbitrary fetch successes/failures and timings,
 *    keeps `current()` total: it never throws and only ever returns a cached
 *    snapshot or `undefined` (fail-open).
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

function randomString(r: () => number, maxLen = 60): string {
  const alphabet = ' {}[]":,\\\u001b\ntrue null0123456789.-eE+Infinity🦄$();`&|';
  let s = '';
  const len = Math.floor(r() * maxLen);
  for (let i = 0; i < len; i += 1) s += alphabet[Math.floor(r() * alphabet.length)];
  return s;
}

/** Build an arbitrary HTTP body: pure noise, or a JSON-ish envelope with junk rows. */
function randomBody(r: () => number): string {
  const roll = r();
  if (roll < 0.4) return randomString(r);
  const rows = Array.from({ length: Math.floor(r() * 6) }, () => ({
    symbol: randomString(r, 8),
    netflowUsd: r() < 0.5 ? randomString(r, 10) : r() * 1e6 - 5e5,
    extra: randomString(r, 5),
  }));
  const wrap = pick(r, ['array', 'data', 'bare']);
  const payload = wrap === 'array' ? rows : wrap === 'data' ? { data: rows } : { junk: rows };
  let json = JSON.stringify(payload);
  if (r() < 0.3) json = json.slice(0, Math.floor(r() * json.length)); // truncate
  return json;
}

const stubFetch = (body: string, status: number): typeof fetch =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

describe('nansen client — fuzzed HTTP responses never panic', () => {
  test('resolves to a bounded, finite snapshot or throws NansenClientError', async () => {
    const r = rng(0x9a5e7);
    for (let i = 0; i < 3_000; i += 1) {
      const status = pick(r, [200, 200, 200, 429, 500, 503, 418]);
      const client = createNansenClient({
        apiKey: 'k',
        endpoint: 'https://api.nansen.test',
        fetchImpl: stubFetch(randomBody(r), status),
        maxRows: 10,
      });
      try {
        const signal = await client.fetchSignal();
        expect(signal.source).toBe('nansen');
        expect(signal.netflows.length).toBeLessThanOrEqual(10);
        for (const row of signal.netflows) {
          expect(typeof row.netflowUsd).toBe('string');
          expect(Number.isFinite(Number(row.netflowUsd))).toBe(true);
        }
      } catch (err) {
        expect(err).toBeInstanceOf(NansenClientError);
      }
    }
  });
});

describe('nansen provider — fuzzed outcomes keep current() total', () => {
  test('never throws; only ever returns a cached snapshot or undefined', async () => {
    const r = rng(0x5163a);
    let nowMs = 0;

    // A client whose every call resolves or rejects per the PRNG.
    const client: NansenClient = {
      fetchSignal: async () => {
        if (r() < 0.5) throw new NansenClientError('fuzzed failure');
        const value: NansenSignal = {
          source: 'nansen',
          endpoint: '/api/v1/smart-money/netflows',
          fetchedAtMs: nowMs,
          netflows: [{ netflowUsd: String(Math.floor(r() * 1000)) }],
        };
        return value;
      },
    };

    const provider = createNansenSignalProvider({
      client,
      pollEveryNTicks: 1 + Math.floor(r() * 5),
      cacheTtlMs: Math.floor(r() * 100),
      now: () => nowMs,
      maxCalls: 200,
    });

    for (let tick = 0; tick < 2_000; tick += 1) {
      nowMs += Math.floor(r() * 50);
      expect(() => provider.maybeRefresh(tick)).not.toThrow();
      // current() is total under any interleaving of in-flight/failed fetches.
      let snapshot: NansenSignal | undefined;
      expect(() => {
        snapshot = provider.current();
      }).not.toThrow();
      if (snapshot !== undefined) expect(snapshot.source).toBe('nansen');
      if (r() < 0.5) await Promise.resolve(); // let some fetches settle
    }
  });
});
