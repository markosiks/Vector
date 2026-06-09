import { describe, expect, test } from 'bun:test';

import type { ElfaClient } from '@/lib/signals/elfa/client';
import { buildElfaMock } from '@/lib/signals/elfa/mock';
import { createElfaSignalProvider } from '@/lib/signals/elfa/provider';
import type { ElfaCallEvent, ElfaSignal } from '@/lib/signals/elfa/types';

/**
 * Unit: the caching/slow-polling provider. A controllable fake client lets each
 * test drive fetch resolution by hand, and an injected clock makes TTL/cadence
 * deterministic. Contracts under test, beyond the Nansen analog: `current()`
 * *always* returns a value (live snapshot or the seeded mock, never `undefined`);
 * a mock-only provider (no client) never touches the network; the tick never
 * blocks; refresh is doubly gated (cadence ∧ TTL); one in-flight call is deduped;
 * the budget hard-stops; and every failure is swallowed (fail-open to last good).
 */

const MOCK = buildElfaMock();
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function liveSignal(rows: number, fetchedAtMs = 0): ElfaSignal {
  return {
    source: 'elfa',
    origin: 'live',
    endpoint: '/v2/aggregations/trending-tokens',
    fetchedAtMs,
    sentiments: Array.from({ length: rows }, (_, i) => ({ symbol: `T${i}`, sentiment: String(i) })),
  };
}

/** A client whose every `fetchSignal` is resolved/rejected explicitly by the test. */
function controllableClient(): {
  client: ElfaClient;
  calls: () => number;
  resolveNext: (value: ElfaSignal) => void;
  rejectNext: (err: Error) => void;
} {
  let count = 0;
  const pending: { resolve: (v: ElfaSignal) => void; reject: (e: Error) => void }[] = [];
  const client: ElfaClient = {
    fetchSignal: () => {
      count += 1;
      return new Promise<ElfaSignal>((resolve, reject) => pending.push({ resolve, reject }));
    },
  };
  return {
    client,
    calls: () => count,
    resolveNext: (value) => pending.shift()?.resolve(value),
    rejectNext: (err) => pending.shift()?.reject(err),
  };
}

describe('elfa provider — mock-only mode (no client wired)', () => {
  test('current() returns the seeded mock and mode() is "mock"', () => {
    const p = createElfaSignalProvider({ mock: MOCK, pollEveryNTicks: 1, cacheTtlMs: 1_000 });
    expect(p.current()).toEqual(MOCK);
    expect(p.mode()).toBe('mock');
  });

  test('maybeRefresh is a no-op: it never touches the network', () => {
    const p = createElfaSignalProvider({ mock: MOCK, pollEveryNTicks: 1, cacheTtlMs: 0 });
    for (let t = 0; t < 100; t += 1) expect(() => p.maybeRefresh(t)).not.toThrow();
    expect(p.current()).toEqual(MOCK); // still the deterministic mock
  });
});

describe('elfa provider — read path (live client wired)', () => {
  test('mode() is "live" and current() serves the mock until the first success', async () => {
    const c = controllableClient();
    const p = createElfaSignalProvider({
      mock: MOCK,
      client: c.client,
      pollEveryNTicks: 1,
      cacheTtlMs: 1_000,
      now: () => 100,
    });
    expect(p.mode()).toBe('live');
    p.maybeRefresh(0);
    expect(c.calls()).toBe(1);
    expect(p.current()).toEqual(MOCK); // in flight → still the mock baseline

    c.resolveNext(liveSignal(3, 100));
    await flush();
    expect(p.current().origin).toBe('live');
    expect(p.current().sentiments).toHaveLength(3);
  });
});

describe('elfa provider — refresh gating', () => {
  test('cadence: at most one fetch per pollEveryNTicks window', async () => {
    const c = controllableClient();
    const p = createElfaSignalProvider({
      mock: MOCK,
      client: c.client,
      pollEveryNTicks: 10,
      cacheTtlMs: 0, // always stale ⇒ cadence is the only gate
      now: () => 0,
    });
    p.maybeRefresh(0);
    c.resolveNext(liveSignal(1));
    await flush();
    expect(c.calls()).toBe(1);

    for (let t = 1; t < 10; t += 1) p.maybeRefresh(t);
    expect(c.calls()).toBe(1);

    p.maybeRefresh(10);
    expect(c.calls()).toBe(2);
  });

  test('TTL: a fresh live cache suppresses a fetch even when the cadence is due', async () => {
    const c = controllableClient();
    let nowMs = 0;
    const p = createElfaSignalProvider({
      mock: MOCK,
      client: c.client,
      pollEveryNTicks: 1,
      cacheTtlMs: 1_000,
      now: () => nowMs,
    });
    p.maybeRefresh(0);
    c.resolveNext(liveSignal(1));
    await flush();
    expect(c.calls()).toBe(1);

    nowMs = 500;
    p.maybeRefresh(1);
    expect(c.calls()).toBe(1);

    nowMs = 1_000;
    p.maybeRefresh(2);
    expect(c.calls()).toBe(2);
  });
});

describe('elfa provider — concurrency & resilience', () => {
  test('a single in-flight request is deduped across a burst of ticks', () => {
    const c = controllableClient();
    const p = createElfaSignalProvider({
      mock: MOCK,
      client: c.client,
      pollEveryNTicks: 1,
      cacheTtlMs: 0,
      now: () => 0,
    });
    for (let t = 0; t < 50; t += 1) p.maybeRefresh(t);
    expect(c.calls()).toBe(1);
  });

  test('fail-open before any success: a rejected fetch leaves the mock in place', async () => {
    const c = controllableClient();
    const p = createElfaSignalProvider({
      mock: MOCK,
      client: c.client,
      pollEveryNTicks: 1,
      cacheTtlMs: 0,
      now: () => 0,
    });
    p.maybeRefresh(0);
    expect(() => c.rejectNext(new Error('boom'))).not.toThrow();
    await flush();
    // No live value yet ⇒ current() still serves the deterministic mock.
    expect(p.current()).toEqual(MOCK);
  });

  test('fail-open against an exotic rejection: a throwing `.name` getter never rejects the detached fetch', async () => {
    // The detached `runFetch` is documented as "never rejects". The one place
    // that could break that is reading `.name` off the thrown value, so a hostile
    // error whose `name` getter throws must still be swallowed (reason 'unknown').
    const exotic = new Error('boom');
    Object.defineProperty(exotic, 'name', {
      get() {
        throw new Error('name getter exploded');
      },
    });
    let count = 0;
    const client: ElfaClient = {
      fetchSignal: () => {
        count += 1;
        return Promise.reject(exotic);
      },
    };
    const events: ElfaCallEvent[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    const p = createElfaSignalProvider({
      mock: MOCK,
      client,
      pollEveryNTicks: 1,
      cacheTtlMs: 0,
      now: () => 0,
      logger: (e) => events.push(e),
    });
    process.on('unhandledRejection', onUnhandled);
    try {
      expect(() => p.maybeRefresh(0)).not.toThrow();
      await flush();
      await flush();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(count).toBe(1);
    expect(unhandled).toHaveLength(0); // the detached fetch did not reject
    // Fail-open: no live value landed ⇒ the mock is still served, and the error
    // was logged with a redacted reason (never the thrown object's details).
    expect(p.current()).toEqual(MOCK);
    const errEvent = events.find((e) => e.type === 'fetch_error');
    expect(errEvent).toBeDefined();
    expect(errEvent && 'reason' in errEvent ? errEvent.reason : undefined).toBe('unknown');
  });

  test('fail-open after a success: a later rejected fetch keeps the last live snapshot', async () => {
    const c = controllableClient();
    const p = createElfaSignalProvider({
      mock: MOCK,
      client: c.client,
      pollEveryNTicks: 1,
      cacheTtlMs: 0,
      now: () => 0,
    });
    p.maybeRefresh(0);
    c.resolveNext(liveSignal(7));
    await flush();
    expect(p.current().sentiments).toHaveLength(7);

    p.maybeRefresh(1);
    expect(() => c.rejectNext(new Error('boom'))).not.toThrow();
    await flush();
    // The failed refresh did not clear or corrupt the cache (did not fall back to mock).
    expect(p.current().origin).toBe('live');
    expect(p.current().sentiments).toHaveLength(7);
  });

  test('budget: maxCalls hard-stops new fetches and logs exhaustion once', async () => {
    const c = controllableClient();
    const events: ElfaCallEvent[] = [];
    const p = createElfaSignalProvider({
      mock: MOCK,
      client: c.client,
      pollEveryNTicks: 1,
      cacheTtlMs: 0,
      now: () => 0,
      maxCalls: 2,
      logger: (e) => events.push(e),
    });
    p.maybeRefresh(0);
    c.resolveNext(liveSignal(1));
    await flush();
    p.maybeRefresh(1);
    c.resolveNext(liveSignal(1));
    await flush();
    expect(c.calls()).toBe(2);

    p.maybeRefresh(2);
    p.maybeRefresh(3);
    expect(c.calls()).toBe(2);

    expect(events.filter((e) => e.type === 'budget_exhausted')).toHaveLength(1);
  });

  test('emits start/success usage events without secrets or bodies', async () => {
    const c = controllableClient();
    const events: ElfaCallEvent[] = [];
    const p = createElfaSignalProvider({
      mock: MOCK,
      client: c.client,
      pollEveryNTicks: 1,
      cacheTtlMs: 0,
      now: () => 0,
      logger: (e) => events.push(e),
    });
    p.maybeRefresh(0);
    c.resolveNext(liveSignal(4));
    await flush();
    expect(events.map((e) => e.type)).toEqual(['fetch_start', 'fetch_success']);
    const success = events.find((e) => e.type === 'fetch_success');
    expect(success?.type === 'fetch_success' ? success.rows : -1).toBe(4);
    for (const e of events) {
      expect(Object.keys(e).sort()).toEqual(
        e.type === 'fetch_success'
          ? ['calls', 'endpoint', 'rows', 'type']
          : ['calls', 'endpoint', 'type'],
      );
    }
    expect(JSON.stringify(events)).not.toContain('sentiment');
  });
});

describe('elfa provider — fault isolation (a throwing logger must not crash the arc)', () => {
  const throwingLogger = (): void => {
    throw new Error('observability sink is down');
  };

  test('a throwing logger does not reject the detached fetch; the snapshot still lands', async () => {
    const c = controllableClient();
    const p = createElfaSignalProvider({
      mock: MOCK,
      client: c.client,
      pollEveryNTicks: 1,
      cacheTtlMs: 1_000,
      now: () => 0,
      logger: throwingLogger,
    });

    expect(() => p.maybeRefresh(0)).not.toThrow();
    c.resolveNext(liveSignal(2));
    await flush();
    expect(p.current().sentiments).toHaveLength(2);
  });

  test('a throwing logger on the synchronous budget path does not throw into the tick', () => {
    const c = controllableClient();
    const p = createElfaSignalProvider({
      mock: MOCK,
      client: c.client,
      pollEveryNTicks: 1,
      cacheTtlMs: 1_000,
      now: () => 0,
      maxCalls: 0, // budget exhausted immediately → `budget_exhausted` logger fires
      logger: throwingLogger,
    });

    expect(() => p.maybeRefresh(0)).not.toThrow();
    expect(c.calls()).toBe(0);
  });
});
