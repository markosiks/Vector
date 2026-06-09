import { expect, test } from '@playwright/test';

/**
 * Operator console browser e2e — the **live** safety arc.
 *
 * The console's page is a server component gated on the real session cookie and
 * the server-only `OPERATOR_CONSOLE_TOKEN`, and every control mutates real state
 * read back by the referee/router. There is nothing meaningful to assert against
 * a mocked network here (the server gate and the referee are the whole point), so
 * this suite runs only against a live server with a seeded database.
 *
 * It is orchestrated by `scripts/e2e/operator-live.ts`, which owns the throwaway
 * schema (with a seed leader holding an allocation), starts `next dev` with
 * `OPERATOR_CONSOLE_TOKEN` set, and exposes the token via `OPERATOR_TOKEN` and the
 * base URL via `OPERATOR_BASE_URL`. A bare `playwright test` skips it.
 *
 * The arc the operator must witness:
 *   1. /operator shows the login card; the token unlocks the console;
 *   2. the scripted attack injects the drain and the console reports a REJECT
 *      (fresh_wallet_transfer_block) against the seed leader;
 *   3. a global HALT freezes execution — re-firing the attack now reports a HALT;
 *   4. resuming clears the halted state.
 */

const LIVE = process.env.OPERATOR_LIVE === '1';
const describeLive = LIVE ? test.describe : test.describe.skip;
const TOKEN = process.env.OPERATOR_TOKEN ?? '';

const ARC_TIMEOUT = 60_000;

describeLive('Operator console — live safety arc', () => {
  test('login → scripted attack REJECT → global HALT → resume', async ({ page }) => {
    test.setTimeout(ARC_TIMEOUT);

    // 1. Login gate.
    await page.goto('/operator');
    await expect(page.getByRole('heading', { name: 'Operator Console' })).toBeVisible();
    await page.getByLabel('Operator token').fill(TOKEN);
    await page.getByRole('button', { name: 'Unlock console' }).click();

    // Console island is now visible (server re-rendered after the cookie was set).
    await expect(page.getByRole('heading', { name: 'Global HALT' })).toBeVisible();
    await expect(page.getByText('Running')).toBeVisible();

    // 2. Scripted attack → REJECT.
    await page.getByRole('button', { name: 'Inject drain attack' }).click();
    await expect(page.getByText(/REJECT/)).toBeVisible();
    await expect(page.getByText(/fresh_wallet_transfer_block/)).toBeVisible();

    // 3. Global HALT freezes execution; the next injection reports a HALT.
    await page.getByRole('button', { name: 'HALT everything' }).click();
    await expect(page.getByText(/HALTED/)).toBeVisible();
    await page.getByRole('button', { name: 'Inject drain attack' }).click();
    await expect(page.getByText(/HALT \//)).toBeVisible();

    // 4. Resume clears the halt.
    await page.getByRole('button', { name: 'Resume all' }).click();
    await expect(page.getByText('Running')).toBeVisible();
  });
});
