/**
 * Live Arena browser e2e orchestrator.
 *
 * Drives the **real** demo-spine pipeline against a **real** Neon database while
 * Playwright watches the `/arena` screen poll the real read API — no network
 * mocks. It owns everything the browser spec must not know about:
 *
 *   1. a throwaway Postgres schema (so the run never touches `public`), wired
 *      into every connection via the URL's `search_path` option;
 *   2. a `next dev` server pointed at that schema;
 *   3. the cold-start setup and a **paced** `runArc(...)` whose round settles are
 *      slowed so the browser's poll cadence can observe each transition: the
 *      capital flow, the blocked fund-drain (red-flash), and the leader's crash
 *      and reroute.
 *
 * The arc start is **not** timer-gated. The cold-start board (seed leader on top)
 * is a transient the browser must catch *before* any state moves, so the arc is
 * held behind a one-shot control endpoint that the spec hits only after it has
 * asserted the opening board. This removes the start-order race between Playwright
 * cold-start / lazy route compilation and the pipeline. Everything the arc unfolds
 * afterwards (the persisted red-flash, the settled crash) survives the browser's
 * poll cadence, so the remaining assertions rely on Playwright's retrying expect.
 *
 * Then it runs the gated `arena.live.spec.ts` against that live server and tears
 * everything down — dropping the schema even on failure. Exit code is the
 * Playwright result, so it is CI-usable.
 *
 *   DATABASE_URL='postgresql://…' bun run test:e2e:live
 *
 * Requires `bunx playwright install chromium` once.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { Pool } from '@neondatabase/serverless';

import { loadMigrations, migrate, MIGRATIONS_DIR } from '@/lib/db/migrate';
import { runArc, setupArc } from '@/lib/replay';
import type { Queryable } from '@/lib/db/types';
import { buildDemoArc } from '@/seed';

const PORT = Number(process.env.ARENA_LIVE_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CONTROL_PORT = PORT + 1;
const CONTROL_URL = `http://127.0.0.1:${CONTROL_PORT}`;
const READY_TIMEOUT_MS = 120_000;
/** Pause on each round settle so ≥2 poll intervals (ui_poll_ms) observe it. */
const SETTLE_PACE_MS = Number(process.env.ARENA_PACE_MS ?? 4_000);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Append a libpq `search_path` option so every connection lands in `schema`. */
function schemaUrl(base: string, schema: string): string {
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}options=${encodeURIComponent(`-c search_path=${schema},public`)}`;
}

async function waitForLeaderboard(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/leaderboard`);
      if (res.ok) {
        const body = (await res.json()) as { data?: unknown[] };
        if (Array.isArray(body.data) && body.data.length === 2) return;
      }
    } catch {
      // server not up yet
    }
    await sleep(500);
  }
  throw new Error(`server did not serve a 2-agent leaderboard within ${READY_TIMEOUT_MS}ms`);
}

/** Trigger Next's lazy compile of `/arena` so the browser's first nav is fast. */
async function warmArena(): Promise<void> {
  try {
    await fetch(`${BASE_URL}/arena`);
  } catch {
    // best-effort; the browser will compile it on navigation otherwise
  }
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, detached = false): ChildProcess {
  return spawn(cmd, args, { stdio: 'inherit', env, detached });
}

function waitExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 1)));
}

async function main(): Promise<number> {
  const base = process.env.DATABASE_URL;
  if (typeof base !== 'string' || base.length === 0) {
    throw new Error('DATABASE_URL is required for the live e2e');
  }

  const schema = `vec_e2e_${randomUUID().replace(/-/g, '')}`;
  const url = schemaUrl(base, schema);
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  const db = client as unknown as Queryable;

  let dev: ChildProcess | undefined;
  let arc: Promise<unknown> | undefined;

  // One-shot gate: the spec releases the arc once it has seen the opening board.
  // `abort` lets teardown unblock a never-released arc without running it.
  let release!: () => void;
  let abort!: () => void;
  const started = new Promise<boolean>((resolve) => {
    release = () => resolve(true);
    abort = () => resolve(false);
  });
  const control = Bun.serve({
    port: CONTROL_PORT,
    fetch(req) {
      if (new URL(req.url).pathname === '/start') {
        release();
        return new Response('ok');
      }
      return new Response('not found', { status: 404 });
    },
  });

  try {
    // 1 — throwaway schema + migrations + cold-start board.
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await migrate(pool, loadMigrations(MIGRATIONS_DIR), { direction: 'up', searchPath: schema });
    const demoArc = buildDemoArc({ rounds: 3 });
    await setupArc(db, demoArc);

    // 2 — dev server pinned to the schema (its own pool inherits the URL option).
    dev = run(
      'bun',
      ['run', 'next', 'dev', '-p', String(PORT)],
      { ...process.env, DATABASE_URL: url },
      true, // own process group so we can signal the whole `next dev` tree
    );
    await waitForLeaderboard();
    await warmArena();

    // 3 — drive the arc, paced, once the browser has confirmed the opening board.
    arc = (async () => {
      const go = await started;
      if (!go) return;
      await runArc(db, demoArc, {
        hooks: {
          onTick: async ({ isRoundSettle }) => {
            if (isRoundSettle) await sleep(SETTLE_PACE_MS);
          },
        },
      });
    })();
    arc.catch((err: unknown) => {
      console.error('[arena-live] arc driver failed:', err);
    });

    // 4 — observe the live screen.
    const pw = run('bunx', ['playwright', 'test', 'tests/browser/arena.live.spec.ts'], {
      ...process.env,
      ARENA_LIVE: '1',
      ARENA_BASE_URL: BASE_URL,
      ARENA_CONTROL_URL: CONTROL_URL,
    });
    return await waitExit(pw);
  } finally {
    // Unblock the gate so a never-released arc resolves to a no-op.
    abort();
    if (dev !== undefined && dev.pid !== undefined) {
      try {
        process.kill(-dev.pid, 'SIGTERM');
      } catch {
        dev.kill('SIGTERM');
      }
    }
    // Let the in-flight arc settle its current transaction before we drop.
    if (arc !== undefined) await arc.catch(() => undefined);
    control.stop(true);
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      client.release();
      await pool.end();
    }
  }
}

process.exit(await main());
