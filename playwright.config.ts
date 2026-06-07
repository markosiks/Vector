import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the Arena browser e2e (P1.6).
 *
 * These specs live in `tests/browser/` — deliberately *not* `tests/e2e/`, which
 * is the bun-test API suite (`bun test tests/e2e`). The two runners never see
 * each other's files. Run the browser suite with `bun run test:e2e:browser`
 * after `bunx playwright install chromium`.
 *
 * The Arena specs script the API at the network layer (`page.route`), so they
 * need only a running Next dev server — no database, no replay engine. The poll
 * cadence is read from the page; the scripted polls reproduce the full arc
 * deterministically. Set `ARENA_BASE_URL` to point at an already-running server,
 * otherwise Playwright starts `next dev` itself.
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
