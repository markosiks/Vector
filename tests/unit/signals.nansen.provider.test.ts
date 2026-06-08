import { describe, expect, test } from 'bun:test';

import type { NansenClient } from '@/lib/signals/nansen/client';
import { createNansenSignalProvider } from '@/lib/signals/nansen/provider';
import type { NansenCallEvent, NansenSignal } from '@/lib/signals/nansen/types';

/**
 * Unit: the caching/slow-polling provider. A controllable fake client lets each
 * test drive fetch resolution by hand, and an injected clock makes TTL/cadence
 * deterministic. The contracts under test: the tick never blocks, refresh is
 * doubly gated (cadence ∧ TTL), one in-flight call is deduped, the budget hard-
 * stops, and every failure is swallowed (fail-open) leaving the last snapshot.
 */

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function signal(rows: number, fetchedAtMs = 0): NansenSignal {
  return {
    source: 'nansen',
    endpoint: '/api/v1/smart-money/netflows',
    fetchedAtMs,
    netflows: Array.from({ length: rows }, (_, i) => ({ netflowUsd: String(i) })),
  };
}

/** A client whose every `fetchSignal` is resolved/rejected explicitly by the test. */
function controllableClient(): {
  client: NansenClient;
  calls: () => number;
  resolveNext: (value: NansenSignal) => void;
  rejectNext: (err: Error) => void;
} {
  let count = 0;
  const pending: { resolve: (v: NansenSignal) => void; reject: (e: Error) => void }[] = [];
  const client: NansenClient = {
    fetchSignal: () => {
      count += 1;
      return new Promise<NansenSignal>((resolve, reject) => pending.push({ resolve, reject }));
    },
  };
  return {
    client,
    calls: () => count,
    resolveNext: (value) => pending.shift()?.resolve(value),
    rejectNext: (err) => pending.shift()?.reject(err),
  };
}

describe('nansen provider — read path', () => {
  test('current() is undefined before any successful fetch and never throws', () => {
    const { client } = controllableClient();
    const p = createNansenSignalProvider({ client, pollEveryNTicks: 1, cacheTtlMs: 1_000 });
    expect(p.current()).toBeUndefined();
  });

  test('a completed refresh becomes visible to current()', async () => {
    const c = controllableClient();
    const p = createNansenSignalProvider({
      client: c.client,
      pollEveryNTicks: 1,
      cacheTtlMs: 1_000,
      now: () => 100,
    });
    p.maybeRefresh(0);
    expect(c.calls()).toBe(1);
    expect(p.current()).toBeUndefined(); // still in flight

    c.resolveNext(signal(3, 100));
    await flush();
    expect(p.current()?.netflows).toHaveLength(3);
  });
});

describe('nansen provider — refresh gating', () => {
  test('cadence: at most one fetch per pollEveryNTicks window', async () => {
    const c = controllableClient();
    const p = createNansenSignalProvider({
      client: c.client,
      pollEveryNTicks: 10,
      cacheTtlMs: 0, // always stale ⇒ cadence is the only gate
      now: () => 0,
    });
    p.maybeRefresh(0);
    c.resolveNext(signal(1));
    await flush();
    expect(c.calls()).toBe(1);

    for (let t = 1; t < 10; t += 1) p.maybeRefresh(t); // inside the window: no fetch
    expect(c.calls()).toBe(1);

    p.maybeRefresh(10); // window elapsed: fetch again
    expect(c.calls()).toBe(2);
  });

  test('TTL: a fresh cache suppresses a fetch even when the cadence is due', async () => {
    const c = controllableClient();
    let nowMs = 0;
    const p = createNansenSignalProvider({
      client: c.client,
      pollEveryNTicks: 1, // cadence always due
      cacheTtlMs: 1_000,
      now: () => nowMs,
    });
    p.maybeRefresh(0);
    c.resolveNext(signal(1));
    await flush();
    expect(c.calls()).toBe(1);

    nowMs = 500; // still within TTL
    p.maybeRefresh(1);
    expect(c.calls()).toBe(1);

    nowMs = 1_000; // TTL elapsed
    p.maybeRefresh(2);
    expect(c.calls()).toBe(2);
  });
});

describe('nansen provider — concurrency & resilience', () => {
  test('a single in-flight request is deduped across a burst of ticks', () => {
    const c = controllableClient();
    const p = createNansenSignalProvider({
      client: c.client,
      pollEveryNTicks: 1,
      cacheTtlMs: 0,
      now: () => 0,
    });
    for (let t = 0; t < 50; t += 1) p.maybeRefresh(t); // never resolved ⇒ stays in flight
    expect(c.calls()).toBe(1);
  });

  test('fail-open: a rejected fetch is swallowed and the last snapshot survives', async () => {
    const c = controllableClient();
    const p = createNansenSignalProvider({
      client: c.client,
      pollEveryNTicks: 1,
      cacheTtlMs: 0,
      now: () => 0,
    });
    p.maybeRefresh(0);
    c.resolveNext(signal(7));
    await flush();
    expect(p.current()?.netflows).toHaveLength(7);

    p.maybeRefresh(1);
    expect(() => c.rejectNext(new Error('boom'))).not.toThrow();
    await flush();
    // The failed refresh did not clear or corrupt the cache.
    expect(p.current()?.netflows).toHaveLength(7);
  });

  test('budget: maxCalls hard-stops new fetches and logs exhaustion once', async () => {
    const c = controllableClient();
    const events: NansenCallEvent[] = [];
    const p = createNansenSignalProvider({
      client: c.client,
      pollEveryNTicks: 1,
      cacheTtlMs: 0,
      now: () => 0,
      maxCalls: 2,
      logger: (e) => events.push(e),
    });
    // Two calls allowed.
    p.maybeRefresh(0);
    c.resolveNext(signal(1));
    await flush();
    p.maybeRefresh(1);
    c.resolveNext(signal(1));
    await flush();
    expect(c.calls()).toBe(2);

    // Third+ are refused; the cache still serves.
    p.maybeRefresh(2);
    p.maybeRefresh(3);
    expect(c.calls()).toBe(2);

    const exhausted = events.filter((e) => e.type === 'budget_exhausted');
    expect(exhausted).toHaveLength(1);
  });

  test('emits start/success usage events without secrets or bodies', async () => {
    const c = controllableClient();
    const events: NansenCallEvent[] = [];
    const p = createNansenSignalProvider({
      client: c.client,
      pollEveryNTicks: 1,
      cacheTtlMs: 0,
      now: () => 0,
      logger: (e) => events.push(e),
    });
    p.maybeRefresh(0);
    c.resolveNext(signal(4));
    await flush();
    expect(events.map((e) => e.type)).toEqual(['fetch_start', 'fetch_success']);
    const success = events.find((e) => e.type === 'fetch_success');
    expect(success?.type === 'fetch_success' ? success.rows : -1).toBe(4);
    // Events carry only counts/labels — never the snapshot rows or a key.
    for (const e of events) {
      expect(Object.keys(e).sort()).toEqual(
        e.type === 'fetch_success'
          ? ['calls', 'endpoint', 'rows', 'type']
          : ['calls', 'endpoint', 'type'],
      );
    }
    expect(JSON.stringify(events)).not.toContain('netflowUsd');
  });
});
