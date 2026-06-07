import { expect, test, type Locator } from '@playwright/test';

/**
 * Arena browser e2e — the **live** arc against a real Neon database.
 *
 * Unlike `arena.spec.ts` (which scripts the read API at the network layer), this
 * suite observes the screen while the **real demo-spine pipeline** drives state
 * through a real Postgres: real referee, scoring, and capital router. Nothing is
 * mocked — the browser polls the real `/api/leaderboard` and `/api/policy-events`.
 *
 * It is orchestrated by `scripts/e2e/arena-live.ts`, which owns the throwaway
 * schema, the dev server, and the paced `runArc(...)` that unfolds the arc. This
 * spec only asserts what the operator sees, and runs **only** under that
 * orchestrator (it needs `ARENA_LIVE=1` and `ARENA_BASE_URL`); a bare
 * `playwright test` skips it.
 *
 * The cold-start board is a transient: the arc is held by the orchestrator until
 * this spec hits `ARENA_CONTROL_URL/start`, which it does only after asserting the
 * opening board. That makes the opening state deterministic instead of racing the
 * pipeline against Playwright cold-start.
 *
 * The arc the operator must witness:
 *   1. the seed leader sits on top of the ranked board;
 *   2. a referee REJECT (the blocked fund-drain) fires the red-flash;
 *   3. the leader's reputation crashes, it falls below the runner-up, and its
 *      capital reroutes away to zero.
 *
 * Every assertion uses Playwright's auto-retrying `expect`, so the cadence of the
 * pipeline and the UI's polling are tolerated without hard-coded sleeps.
 */

const LIVE = process.env.ARENA_LIVE === '1';
const describeLive = LIVE ? test.describe : test.describe.skip;

/** Generous ceiling: the orchestrator paces the arc over ~15–20s. */
const ARC_TIMEOUT = 90_000;

/** Release the orchestrator's paused arc once the opening board is confirmed. */
async function releaseArc(): Promise<void> {
  const control = process.env.ARENA_CONTROL_URL;
  if (control === undefined || control === '') {
    throw new Error('ARENA_CONTROL_URL is required to drive the live arc');
  }
  const res = await fetch(`${control}/start`);
  if (!res.ok) throw new Error(`arc control returned ${res.status}`);
}

describeLive('Arena — live arc on real Neon', () => {
  test('leader leads, REJECT flashes, then the leader crashes and reroutes to zero', async ({
    page,
  }) => {
    test.setTimeout(ARC_TIMEOUT + 30_000);

    await page.goto('/arena');

    const board = page.getByTestId('leaderboard');
    const rows: Locator = page.getByTestId('agent-row');

    // 1 — the board renders with both seed agents; the leader is on top. The arc
    //     is paused, so this opening state is stable rather than racing the pipeline.
    await expect(board).toBeVisible({ timeout: ARC_TIMEOUT });
    await expect(rows).toHaveCount(2, { timeout: ARC_TIMEOUT });
    await expect(rows.first()).toContainText('seed-leader', { timeout: ARC_TIMEOUT });

    // Opening board confirmed — release the arc so the rest of it unfolds.
    await releaseArc();

    // 2 — the blocked fund-drain fires the screen-level red-flash. The banner is
    //     keyed on the first block and persists once it has fired.
    const banner = page.getByTestId('flash-banner');
    await expect(banner).toBeVisible({ timeout: ARC_TIMEOUT });
    await expect(banner).toContainText('REJECT');

    // 3 — the crash flips the ranking: the runner-up takes rank 1 and the old
    //     leader sinks to the bottom with its capital rerouted away to zero.
    await expect(rows.first()).toContainText('seed-2', { timeout: ARC_TIMEOUT });
    const lastRow = rows.last();
    await expect(lastRow).toContainText('seed-leader', { timeout: ARC_TIMEOUT });
    await expect(lastRow.getByTestId('capital-value')).toHaveText('0', { timeout: ARC_TIMEOUT });
  });
});
