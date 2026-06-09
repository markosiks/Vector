import { describe, expect, test } from 'bun:test';

import { createElfaClient, ElfaClientError } from '@/lib/signals/elfa/client';
import { buildElfaMock } from '@/lib/signals/elfa/mock';
import { createElfaSignalProvider } from '@/lib/signals/elfa/provider';
import type { ElfaClient } from '@/lib/signals/elfa/client';
import type { ElfaSignal } from '@/lib/signals/elfa/types';

/**
 * Property/fuzz tests for the Elfa signal's untrusted boundaries (P3.1).
 * Determinism is controlled with a seeded PRNG so a failure reproduces exactly.
 * Invariants:
 *  - `fetchSignal` over an *arbitrary* HTTP body either resolves with a
 *    well-formed {@link ElfaSignal} (bounded rows, every `sentiment` a finite
 *    numeric string) or rejects with an {@link ElfaClientError} — never panics
 *    with a foreign error and never yields `NaN`/`Infinity`/oversized output;
 *  - the provider, driven by arbitrary fetch successes/failures and timings,
 *    keeps `current()` total *and always populated*: it never throws and only
 *    ever returns a live snapshot or the seeded mock (never `undefined`).
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
    sentiment: r() < 0.5 ? randomString(r, 10) : r() * 2 - 1,
    extra: randomString(r, 5),
  }));
  const wrap = pick(r, ['array', 'data', 'nested', 'bare']);
  const payload =
    wrap === 'array'
      ? rows
      : wrap === 'data'
        ? { data: rows }
        : wrap === 'nested'
          ? { data: { items: rows } }
          : { junk: rows };
  let json = JSON.stringify(payload);
  if (r() < 0.3) json = json.slice(0, Math.floor(r() * json.length)); // truncate
  return json;
}

const stubFetch = (body: string, status: number): typeof fetch =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

describe('elfa client — fuzzed HTTP responses never panic', () => {
  test('resolves to a bounded, finite snapshot or throws ElfaClientError', async () => {
    const r = rng(0x9a5e7);
    for (let i = 0; i < 3_000; i += 1) {
      const status = pick(r, [200, 200, 200, 402, 429, 500, 503, 418]);
      const client = createElfaClient({
        apiKey: 'k',
        endpoint: 'https://api.elfa.test',
        fetchImpl: stubFetch(randomBody(r), status),
        maxRows: 10,
      });
      try {
        const signal = await client.fetchSignal();
        expect(signal.source).toBe('elfa');
        expect(signal.origin).toBe('live');
        expect(signal.sentiments.length).toBeLessThanOrEqual(10);
        for (const row of signal.sentiments) {
          expect(typeof row.sentiment).toBe('string');
          expect(Number.isFinite(Number(row.sentiment))).toBe(true);
        }
      } catch (err) {
        expect(err).toBeInstanceOf(ElfaClientError);
      }
    }
  });
});

describe('elfa provider — fuzzed outcomes keep current() total and populated', () => {
  test('never throws; only ever returns a live snapshot or the seeded mock', async () => {
    const r = rng(0x5163a);
    const mock = buildElfaMock();
    let nowMs = 0;

    const client: ElfaClient = {
      fetchSignal: async () => {
        if (r() < 0.5) throw new ElfaClientError('fuzzed failure');
        const value: ElfaSignal = {
          source: 'elfa',
          origin: 'live',
          endpoint: '/v2/aggregations/trending-tokens',
          fetchedAtMs: nowMs,
          sentiments: [{ symbol: 'X', sentiment: String(Math.floor(r() * 200) - 100) }],
        };
        return value;
      },
    };

    const provider = createElfaSignalProvider({
      mock,
      client,
      pollEveryNTicks: 1 + Math.floor(r() * 5),
      cacheTtlMs: Math.floor(r() * 100),
      now: () => nowMs,
      maxCalls: 200,
    });

    for (let tick = 0; tick < 2_000; tick += 1) {
      nowMs += Math.floor(r() * 50);
      expect(() => provider.maybeRefresh(tick)).not.toThrow();
      let snapshot: ElfaSignal | undefined;
      expect(() => {
        snapshot = provider.current();
      }).not.toThrow();
      // current() is total AND never undefined: always a well-formed elfa signal.
      expect(snapshot?.source).toBe('elfa');
      expect(snapshot?.origin === 'live' || snapshot?.origin === 'mock').toBe(true);
      if (r() < 0.5) await Promise.resolve();
    }
  });

  test('a mock-only provider never fetches under any tick interleaving', () => {
    const r = rng(0x71c3);
    const mock = buildElfaMock();
    let fetched = 0;
    const client: ElfaClient = {
      fetchSignal: async () => {
        fetched += 1;
        return mock;
      },
    };
    // No client wired ⇒ mock-only. (The client above is intentionally NOT passed.)
    void client;
    const provider = createElfaSignalProvider({
      mock,
      pollEveryNTicks: 1,
      cacheTtlMs: 0,
      now: () => 0,
    });
    for (let tick = 0; tick < 1_000; tick += 1) {
      provider.maybeRefresh(Math.floor(r() * 10_000));
      expect(provider.current()).toEqual(mock);
    }
    expect(fetched).toBe(0);
  });
});
