import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the Arena browser e2e (P1.6).
 *
 * These specs live in `tests/browser/` — deliberately *not* `tests/e2e/`, which
 * is the bun-test API suite (`bun test tests/e2e`). The two runners never see
 * each other's files. Run the browser suite with `bun run test:e2e:browser`
 * after `bunx playwright install chromium`.
 *
 * Two suites share this config:
 *  - `arena.spec.ts` scripts the API at the network layer (`page.route`), so it
 *    needs only a running Next dev server — no database, no replay engine. The
 *    scripted polls reproduce the full arc deterministically.
 *  - `arena.live.spec.ts` (gated on `ARENA_LIVE=1`) observes the screen while the
 *    real demo-spine pipeline drives a real Neon database. It is launched by
 *    `scripts/e2e/arena-live.ts` (`bun run test:e2e:live`), which owns the
 *    throwaway schema, the dev server, and the paced `runArc(...)`.
 *
 * Set `ARENA_BASE_URL` to point at an already-running server (the live
 * orchestrator does), otherwise Playwright starts `next dev` itself.
 */
const baseURL = process.env.ARENA_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    // The arc is timing-sensitive; give actions room without being flaky.
    actionTimeout: 10_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Only manage the server ourselves when no external one is provided.
  ...(process.env.ARENA_BASE_URL
    ? {}
    : {
        webServer: {
          command: 'bun run dev',
          url: baseURL,
          timeout: 120_000,
          reuseExistingServer: !process.env.CI,
        },
      }),
});
