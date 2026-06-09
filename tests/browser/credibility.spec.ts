import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Credibility screens browser e2e (P2.3) — the two screens the demo's trust
 * story rests on, made deterministic by scripting the read API at the network
 * layer (`page.route`), so the suite needs only a running Next dev server: no
 * database, no chain, no replay engine.
 *
 *  - Attestation Log: a row posted `optimistic` flips to `confirmed` on a later
 *    poll (the badge + explorer link the screen animates), a `failed` row shows
 *    its terminal note, and an empty feed shows the empty state.
 *  - Agent detail: the EWMA chart, the explicit score breakdown
 *    (`100·perf·w + policy − dd`, clamped), and the referee decision badges
 *    render; a malformed id resolves to the explicit not-found state.
 *
 * Assertions use Playwright's auto-retrying `expect`, which tolerates the
 * `ui_poll_ms` cadence without hard-coded sleeps.
 */

const TX = `0x${'b'.repeat(64)}`;

const optimisticRow = {
  id: 'att-1',
  agent_id: 'agent-1',
  round_id: 'round-1',
  value: '73',
  value_decimals: 0,
  tag1: 'agentscore',
  tag2: null,
  feedback_uri: 'ipfs://x',
  feedback_hash: `0x${'a'.repeat(64)}`,
  chain_state: 'optimistic' as const,
  tx_hash: null as string | null,
  block_number: null as string | null,
  created_at: '2026-06-07T12:00:00.000Z',
  confirmed_at: null as string | null,
};

const confirmedRow = {
  ...optimisticRow,
  chain_state: 'confirmed' as const,
  tx_hash: TX,
  block_number: '12345678',
  confirmed_at: '2026-06-07T12:00:05.000Z',
};

const failedRow = {
  ...optimisticRow,
  id: 'att-2',
  chain_state: 'failed' as const,
  tx_hash: TX,
  created_at: '2026-06-07T11:59:00.000Z',
};

function page200(route: Route, data: unknown[]): Promise<void> {
  return route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data, next_cursor: null }),
  });
}

test.describe('Attestation Log', () => {
  test('an optimistic record flips to confirmed on a later poll', async ({
    page,
  }: {
    page: Page;
  }) => {
    let poll = 0;
    await page.route('**/api/attestations*', async (route: Route) => {
      poll += 1;
      // First poll: pending. Subsequent polls: the reconciler confirmed it.
      await page200(route, [poll <= 1 ? optimisticRow : confirmedRow]);
    });

    await page.goto('/attestations');

    const badge = page.getByTestId('chain-state-badge').first();
    await expect(badge).toContainText(/optimistic|pending/i);

    // On the next poll the same row is confirmed and exposes an explorer link.
    await expect(page.getByTestId('confirmed-note')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(`a[href$="/tx/${TX}"]`)).toBeVisible();
  });

  test('a failed record shows its terminal note', async ({ page }: { page: Page }) => {
    await page.route('**/api/attestations*', (route: Route) => page200(route, [failedRow]));
    await page.goto('/attestations');
    await expect(page.getByTestId('failed-note')).toBeVisible({ timeout: 30_000 });
  });

  test('an empty feed shows the empty state, not a spinner forever', async ({
    page,
  }: {
    page: Page;
  }) => {
    await page.route('**/api/attestations*', (route: Route) => page200(route, []));
    await page.goto('/attestations');
    await expect(page.getByTestId('attestations-empty')).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('Agent detail', () => {
  const agent = {
    id: 'agent-1',
    display_name: 'Cred Subject',
    owner: 'ops',
    strategy_kind: 'seed',
    status: 'active',
    score_current: '73.0',
    agent_id_onchain: null,
    created_at: '2026-06-07T12:00:00.000Z',
  };

  const detail = {
    agent,
    scores: [
      {
        round_id: 'r0',
        raw_r: '60.0',
        score_r: '60.0',
        components: { perf: 0.8, w: 0.9, policy: 0, dd: 12 },
        created_at: '2026-06-07T12:00:00.000Z',
      },
      {
        round_id: 'r1',
        raw_r: '73.0',
        score_r: '73.0',
        components: { perf: 0.85, w: 0.95, policy: 0, dd: 7.75 },
        created_at: '2026-06-07T12:01:00.000Z',
      },
    ],
    intents: [
      {
        id: 'i1',
        round_id: 'r1',
        intent_hash: '0xabc',
        action: 'open',
        market: 'ETH-PERP',
        side: 'long',
        size: '1.5',
        leverage: '3',
        tp: null,
        sl: null,
        max_slippage: null,
        target_address: null,
        created_at: '2026-06-07T12:01:00.000Z',
      },
    ],
    policy_events: [
      {
        id: 'e1',
        intent_id: 'i1',
        agent_id: 'agent-1',
        round_id: 'r1',
        rule_fired: 'leverage_cap',
        decision: 'CLIP',
        severity: 'soft',
        detail: null,
        created_at: '2026-06-07T12:01:01.000Z',
      },
    ],
    outcomes: [
      {
        id: 'o1',
        round_id: 'r1',
        execution_id: 'x1',
        pnl_realized: '12.5',
        pnl_marked: '12.5',
        capital_at_risk: '1000.00',
        fees: '0.25',
        position_delta: '1.5',
        drawdown: '0.05',
        created_at: '2026-06-07T12:01:02.000Z',
      },
    ],
  };

  test('renders the EWMA chart, explicit breakdown, and decision badge', async ({
    page,
  }: {
    page: Page;
  }) => {
    await page.route('**/api/agents/agent-1', (route: Route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(detail) }),
    );

    await page.goto('/agents/agent-1');

    await expect(page.getByTestId('agent-score')).toContainText('73');
    await expect(page.getByTestId('ewma-chart')).toBeVisible();

    // The breakdown shows the explicit formula terms, not a flat sum.
    const breakdown = page.getByTestId('score-breakdown');
    await expect(breakdown).toBeVisible();
    await expect(page.getByTestId('raw-value')).toContainText('73');

    // The referee's verdict on the recent intent is shown as a badge.
    await expect(page.getByTestId('decision-badge').first()).toContainText('CLIP');
  });

  test('a malformed id resolves to the explicit not-found state', async ({
    page,
  }: {
    page: Page;
  }) => {
    await page.route('**/api/agents/not-a-uuid', (route: Route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'invalid_id', message: 'invalid id' }),
      }),
    );
    await page.goto('/agents/not-a-uuid');
    await expect(page.getByTestId('agent-not-found')).toBeVisible({ timeout: 30_000 });
  });
});
