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

/**
 * Explorer URL for a transaction hash. Re-exported from
 * {@link import('@/lib/credibility/explorer').explorerTxUrl} — that version
 * validates the hash format and returns `null` for invalid input, preventing
 * attacker-controlled strings from silently appearing in URLs.
 *
 * @deprecated Import directly from `@/lib/credibility/explorer` for new code.
 *   This re-export exists only to keep existing consumers working.
 */
export { explorerTxUrl } from '@/lib/credibility/explorer';
