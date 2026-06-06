import { CONFIG } from './constants';

/**
 * Thin, pure consumers of the seeded config. They exist so the rest of the app
 * (and the single-source e2e test) can depend on derived values without ever
 * touching a raw literal. Each function reads {@link CONFIG} and nothing else.
 */

/** The SWR refresh interval, in milliseconds, used by every live screen. */
export function swrRefreshIntervalMs(): number {
  return CONFIG.timing.ui_poll_ms;
}

/** Whether a score clears the router's eligibility gate (§6.2 step 1). */
export function isEligible(score: number): boolean {
  return score >= CONFIG.router.s_min;
}

/** Build an explorer URL for a transaction hash on Mantle testnet (§7.3/P2.3). */
export function explorerTxUrl(txHash: string): string {
  return `${CONFIG.chain.mantle_explorer_base_url}/tx/${txHash}`;
}
