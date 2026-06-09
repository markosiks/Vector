import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from '@neondatabase/serverless';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { loadMigrations, migrate, MIGRATIONS_DIR } from '@/lib/db/migrate';
import type { Queryable } from '@/lib/db/types';
import { runArc, type RunArcResult } from '@/lib/replay';
import {
  buildElfaMock,
  createElfaClient,
  createElfaSignalProvider,
  ElfaClientError,
  type ElfaCallEvent,
  type ElfaClient,
} from '@/lib/signals/elfa';
import { buildDemoArc } from '@/seed';

/**
 * Integration for the Elfa signal (P3.1), in two independently-gated parts:
 *
 *  - **Arc invariance (real Neon, gated on `DATABASE_URL`).** Wiring a live —
 *    even *flapping* — Elfa provider (which falls back to the seeded mock on
 *    failure) into `runArc` must not change the deterministic end-state: same
 *    crashed agents, same final allocations as the baseline run. A separate run
 *    wires a *mock-only* provider and asserts the same invariance. Both prove the
 *    signal never gates or perturbs the tick.
 *
 *  - **Live endpoint (gated on `ELFA_API_KEY`).** One real call against the
 *    configured endpoint, asserting the client returns a well-formed snapshot or
 *    degrades to a typed error (a credit/permission/payment issue must not
 *    hard-fail).
 */

const hasDb = typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0;
const describeDb = hasDb ? describe : describe.skip;

const hasKey = typeof process.env.ELFA_API_KEY === 'string' && process.env.ELFA_API_KEY.length > 0;
const describeKey = hasKey ? describe : describe.skip;

/** A client that flaps: roughly half its calls reject, the rest resolve. */
function flappingClient(): ElfaClient {
  let n = 0;
  return {
    fetchSignal: async () => {
      n += 1;
      if (n % 2 === 0) throw new ElfaClientError('flap');
      return {
        source: 'elfa',
        origin: 'live',
        endpoint: '/v2/aggregations/trending-tokens',
        fetchedAtMs: Date.now(),
        sentiments: [{ symbol: 'BTC', sentiment: String((n % 7) / 10) }],
      };
    },
  };
}

const byAgent = (r: RunArcResult) =>
  [...r.finalAllocations].sort((a, b) => a.agentId.localeCompare(b.agentId));

function expectSameEndState(a: RunArcResult, baseline: RunArcResult): void {
  expect(a.rounds).toBe(baseline.rounds);
  expect(a.ticks).toBe(baseline.ticks);
  expect([...a.crashedAgentIds].sort()).toEqual([...baseline.crashedAgentIds].sort());
  expect(byAgent(a)).toEqual(byAgent(baseline));
}

describeDb('elfa arc invariance (isolated schemas on real Neon)', () => {
  const schemas = {
    base: `vec_elfa_base_${randomUUID().replace(/-/g, '')}`,
    live: `vec_elfa_live_${randomUUID().replace(/-/g, '')}`,
    mock: `vec_elfa_mock_${randomUUID().replace(/-/g, '')}`,
  };
  let pool: Pool;
  const clients: Record<string, PoolClient> = {};
  // Computed once on the `base` schema and reused by both tests: the baseline is
  // deterministic, and re-running `runArc` on the same schema would accumulate
  // state, so we capture the result data exactly once.
  let baseline: RunArcResult;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    for (const [name, schema] of Object.entries(schemas)) {
      const client = await pool.connect();
      clients[name] = client;
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await migrate(pool, loadMigrations(MIGRATIONS_DIR), { direction: 'up', searchPath: schema });
    }
    baseline = await runArc(clients.base as unknown as Queryable, buildDemoArc({ rounds: 3 }));
  });

  afterAll(async () => {
    try {
      for (const [name, schema] of Object.entries(schemas)) {
        await clients[name]?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
    } finally {
      for (const client of Object.values(clients)) client.release();
      await pool.end();
    }
  });

  test('a flapping (live, mock-fallback) Elfa provider does not change the arc end-state', async () => {
    const arc = buildDemoArc({ rounds: 3 });
    const events: ElfaCallEvent[] = [];
    const provider = createElfaSignalProvider({
      mock: buildElfaMock(),
      client: flappingClient(),
      pollEveryNTicks: 1,
      cacheTtlMs: 0,
      logger: (e) => events.push(e),
    });
    const withSignal = await runArc(clients.live as unknown as Queryable, arc, { elfa: provider });

    expectSameEndState(withSignal, baseline);
    // The provider was actually exercised (polled) during the run.
    expect(events.some((e) => e.type === 'fetch_start')).toBe(true);
  });

  test('a mock-only Elfa provider does not change the arc end-state', async () => {
    const arc = buildDemoArc({ rounds: 3 });
    const provider = createElfaSignalProvider({
      mock: buildElfaMock(),
      pollEveryNTicks: 1,
      cacheTtlMs: 0,
    });
    expect(provider.mode()).toBe('mock');
    const withMock = await runArc(clients.mock as unknown as Queryable, arc, { elfa: provider });

    expectSameEndState(withMock, baseline);
  });
});

describeKey('elfa live endpoint (gated on ELFA_API_KEY)', () => {
  test('one real call returns a well-formed snapshot or a typed error', async () => {
    const client = createElfaClient({
      apiKey: process.env.ELFA_API_KEY as string,
      endpoint: CONFIG.elfa.endpoint,
      timeoutMs: 8_000,
    });
    try {
      const signal = await client.fetchSignal();
      expect(signal.source).toBe('elfa');
      expect(signal.origin).toBe('live');
      expect(Array.isArray(signal.sentiments)).toBe(true);
      for (const row of signal.sentiments) {
        expect(Number.isFinite(Number(row.sentiment))).toBe(true);
      }
    } catch (err) {
      expect(err).toBeInstanceOf(ElfaClientError);
    }
  });
});
