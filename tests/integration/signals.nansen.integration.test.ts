import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from '@neondatabase/serverless';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { loadMigrations, migrate, MIGRATIONS_DIR } from '@/lib/db/migrate';
import type { Queryable } from '@/lib/db/types';
import { runArc, type RunArcResult } from '@/lib/replay';
import {
  createNansenClient,
  createNansenSignalProvider,
  NansenClientError,
  type NansenClient,
} from '@/lib/signals/nansen';
import type { NansenCallEvent } from '@/lib/signals/nansen';
import { buildDemoArc } from '@/seed';

/**
 * Integration for the Nansen signal (P2.2), in two independently-gated parts:
 *
 *  - **Arc invariance (real Neon, gated on `DATABASE_URL`).** Wiring a live —
 *    even *flapping* — Nansen provider into `runArc` must not change the
 *    deterministic end-state: same crashed agents, same final allocations as the
 *    baseline run. This proves the signal never gates or perturbs the tick.
 *
 *  - **Live endpoint (gated on `NANSEN_API_KEY`).** One real call against the
 *    configured endpoint, asserting the client returns a well-formed snapshot or
 *    degrades to a typed error (a credit/permission issue must not hard-fail).
 */

const hasDb = typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0;
const describeDb = hasDb ? describe : describe.skip;

const hasKey =
  typeof process.env.NANSEN_API_KEY === 'string' && process.env.NANSEN_API_KEY.length > 0;
const describeKey = hasKey ? describe : describe.skip;

/** A client that flaps: roughly half its calls reject, the rest resolve. */
function flappingClient(): NansenClient {
  let n = 0;
  return {
    fetchSignal: async () => {
      n += 1;
      if (n % 2 === 0) throw new NansenClientError('flap');
      return {
        source: 'nansen',
        endpoint: '/api/v1/smart-money/netflows',
        fetchedAtMs: Date.now(),
        netflows: [{ symbol: 'WETH', netflowUsd: String(n) }],
      };
    },
  };
}

describeDb('nansen arc invariance (isolated schemas on real Neon)', () => {
  const baseSchema = `vec_nansen_base_${randomUUID().replace(/-/g, '')}`;
  const liveSchema = `vec_nansen_live_${randomUUID().replace(/-/g, '')}`;
  let pool: Pool;
  let baseClient: PoolClient;
  let liveClient: PoolClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    baseClient = await pool.connect();
    liveClient = await pool.connect();
    for (const [client, schema] of [
      [baseClient, baseSchema],
      [liveClient, liveSchema],
    ] as const) {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await migrate(pool, loadMigrations(MIGRATIONS_DIR), { direction: 'up', searchPath: schema });
    }
  });

  afterAll(async () => {
    try {
      await baseClient.query(`DROP SCHEMA IF EXISTS ${baseSchema} CASCADE`);
      await liveClient.query(`DROP SCHEMA IF EXISTS ${liveSchema} CASCADE`);
    } finally {
      baseClient.release();
      liveClient.release();
      await pool.end();
    }
  });

  test('a flapping Nansen provider does not change the arc end-state', async () => {
    const arc = buildDemoArc({ rounds: 3 });

    const baseline: RunArcResult = await runArc(baseClient as unknown as Queryable, arc);

    const events: NansenCallEvent[] = [];
    const provider = createNansenSignalProvider({
      client: flappingClient(),
      pollEveryNTicks: 1, // poll aggressively to stress the path
      cacheTtlMs: 0,
      logger: (e) => events.push(e),
    });
    const withSignal: RunArcResult = await runArc(liveClient as unknown as Queryable, arc, {
      nansen: provider,
    });

    // The deterministic outcome is identical despite the live, flapping signal.
    expect(withSignal.rounds).toBe(baseline.rounds);
    expect(withSignal.ticks).toBe(baseline.ticks);
    expect([...withSignal.crashedAgentIds].sort()).toEqual([...baseline.crashedAgentIds].sort());
    expect(withSignal.finalAllocations).toEqual(baseline.finalAllocations);

    // And the provider was actually exercised (polled) during the run.
    expect(events.some((e) => e.type === 'fetch_start')).toBe(true);
  });
});

describeKey('nansen live endpoint (gated on NANSEN_API_KEY)', () => {
  test('one real call returns a well-formed snapshot or a typed error', async () => {
    const client = createNansenClient({
      apiKey: process.env.NANSEN_API_KEY as string,
      endpoint: CONFIG.nansen.endpoint,
      timeoutMs: 8_000,
    });
    try {
      const signal = await client.fetchSignal();
      expect(signal.source).toBe('nansen');
      expect(Array.isArray(signal.netflows)).toBe(true);
      for (const row of signal.netflows) {
        expect(Number.isFinite(Number(row.netflowUsd))).toBe(true);
      }
    } catch (err) {
      expect(err).toBeInstanceOf(NansenClientError);
    }
  });
});
