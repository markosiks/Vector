import { ELFA_TRENDING_PATH } from './client';
import type { ElfaSignal } from './types';

/**
 * The deterministic seeded Elfa snapshot (P3.1, §4.2).
 *
 * This is the fail-open baseline the provider serves whenever a live value is
 * unavailable — no key, `mock` mode, or a failed/timed-out live fetch. It is
 * what guarantees the signal is *always present* in `context.signals.elfa`.
 *
 * Determinism: every field is a fixed literal, including `fetchedAtMs` (a frozen
 * sentinel, **not** `Date.now()`), so the mock is byte-stable across runs. That
 * is what lets the demo enable Elfa in `mock` mode without making the arc
 * non-deterministic — embedding this snapshot in `context` cannot change the
 * signed Intent bytes because the seed strategies ignore `context.signals`.
 *
 * The sentiment values are illustrative, in a vendor-plausible range, and 
 * `origin: 'mock'` marks them transparently as seeded rather than live.
 */
const SEEDED_FETCHED_AT_MS = 1_700_000_000_000;

/** Frozen seeded sentiment rows. Small and self-describing; values are illustrative. */
const SEEDED_SENTIMENTS: ElfaSignal['sentiments'] = [
  { symbol: 'BTC', sentiment: '0.62', mentions: '1840', mindshare: '0.31' },
  { symbol: 'ETH', sentiment: '0.48', mentions: '1210', mindshare: '0.22' },
  { symbol: 'SOL', sentiment: '-0.15', mentions: '430', mindshare: '0.07' },
];

/**
 * Build the deterministic seeded Elfa snapshot. Returns a fresh frozen object on
 * each call so a caller cannot mutate shared state; the *value* is identical
 * every time.
 */
export function buildElfaMock(): ElfaSignal {
  return Object.freeze({
    source: 'elfa',
    origin: 'mock',
    endpoint: ELFA_TRENDING_PATH,
    fetchedAtMs: SEEDED_FETCHED_AT_MS,
    sentiments: Object.freeze(SEEDED_SENTIMENTS.map((s) => Object.freeze({ ...s }))),
  }) as ElfaSignal;
}
