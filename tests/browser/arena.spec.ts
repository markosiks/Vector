import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Arena browser e2e — the visible 90-second arc, made deterministic.
 *
 * Rather than depend on a live replay engine and a database, we script the two
 * read endpoints at the network layer. Each leaderboard poll advances a frame
 * counter; the policy feed returns the events visible up to that frame. The
 * frames reproduce the full arc the screen must survive:
 *
 *   frame 0  steady state — Leader ahead on score and capital
 *   frame 1  capital flows from the Leader to the runner-up (bars animate)
 *   frame 2  a REFEREE REJECT fires → red-flash within one poll
 *   frame 3  the Leader's reputation crashes and it falls in rank (FLIP)
 *
 * Because the arc is driven by the page's own polling, the assertions use
 * Playwright's auto-retrying `expect`, which tolerates the poll cadence without
 * hard-coded sleeps.
 */

const round = (state: string) => ({
  id: '00000000-0000-0000-0000-0000000000aa',
  index: 42,
  state,
  started_at: '2026-06-07T12:00:00.000Z',
  settled_at: null,
});

const agent = (
  id: string,
  display_name: string,
  score_current: string,
  allocation: string | null,
  status = 'active',
) => ({
  id,
  display_name,
  owner: 'ops',
  strategy_kind: 'seed',
  status,
  score_current,
  agent_id_onchain: null,
  allocation,
  created_at: '2026-06-07T12:00:00.000Z',
});

const L = 'agent-leader';
const R = 'agent-runner';
const C = 'agent-three';

const rejectEvent = {
  id: 'evt-reject-1',
  intent_id: '00000000-0000-0000-0000-0000000000b1',
  agent_id: L,
  round_id: '00000000-0000-0000-0000-0000000000aa',
  rule_fired: 'leverage_cap',
  decision: 'REJECT',
  severity: 'hard',
  detail: null,
  created_at: '2026-06-07T12:01:00.000Z',
};

/** Leaderboard state per frame (newest poll wins; the last frame is sticky). */
const FRAMES = [
  [
    agent(L, 'Leader', '80', '600000'),
    agent(R, 'Runner', '70', '300000'),
    agent(C, 'Three', '50', '100000'),
  ],
  [
    agent(L, 'Leader', '80', '350000'),
    agent(R, 'Runner', '70', '550000'),
    agent(C, 'Three', '50', '100000'),
  ],
  [
    agent(L, 'Leader', '7', '350000', 'halted'),
    agent(R, 'Runner', '70', '550000'),
    agent(C, 'Three', '50', '100000'),
  ],
  [
    agent(L, 'Leader', '7', '50000', 'halted'),
    agent(R, 'Runner', '70', '850000'),
    agent(C, 'Three', '50', '100000'),
  ],
] as const;

/** Policy events visible by frame index (cumulative, newest-first). */
const EVENTS_BY_FRAME: readonly (readonly unknown[])[] = [[], [], [rejectEvent], [rejectEvent]];

async function installArenaApi(page: Page): Promise<void> {
  let frame = 0;
  await page.route('**/api/leaderboard', async (route: Route) => {
    const i = Math.min(frame, FRAMES.length - 1);
    frame += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ round: round('open'), capital_unit: 'tMNT', data: FRAMES[i] }),
    });
  });
  await page.route('**/api/policy-events*', async (route: Route) => {
    const i = Math.min(frame, EVENTS_BY_FRAME.length - 1);
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: EVENTS_BY_FRAME[i], next_cursor: null }),
    });
  });
}

test.describe('Arena arc', () => {
  test.beforeEach(async ({ page }) => {
    await installArenaApi(page);
    await page.goto('/arena');
  });

  test('renders the ranked board with the leader on top', async ({ page }) => {
    await expect(page.getByTestId('leaderboard')).toBeVisible();
    const rows = page.getByTestId('agent-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('Leader');
  });

  test('capital flows from the leader to the runner-up', async ({ page }) => {
    // The runner-up's capital climbs as allocation moves to it over the polls.
    await expect(page.getByText('850,000')).toBeVisible({ timeout: 30_000 });
  });

  test('a policy REJECT fires the red-flash within the arc', async ({ page }) => {
    await expect(page.getByTestId('flash-banner')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('flash-banner')).toContainText('REJECT');
  });

  test('the crashed leader falls below the new leader', async ({ page }) => {
    const rows = page.getByTestId('agent-row');
    // Once the crash lands, the runner-up holds rank 1 and the old leader sinks.
    await expect(rows.first()).toContainText('Runner', { timeout: 30_000 });
    await expect(rows.last()).toContainText('Leader');
  });
});
