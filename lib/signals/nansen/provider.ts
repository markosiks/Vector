import type { NansenClient } from './client';
import type { NansenLogger, NansenSignal, NansenSignalProvider } from './types';

/**
 * The caching, slow-polling provider that fronts a {@link NansenClient} (P2.2).
 *
 * It enforces the two invariants the orchestrator depends on:
 *  1. **The tick never blocks on the network.** {@link NansenSignalProvider.current}
 *     returns a cached value synchronously; {@link NansenSignalProvider.maybeRefresh}
 *     only ever *starts* a detached fetch and returns at once.
 *  2. **Fail-open.** Any client failure (timeout, 429, 5xx, bad JSON) is
 *     swallowed; the last good snapshot stays in place, so a broken or absent
 *     Nansen never stalls or corrupts the arc.
 *
 * Refresh is doubly gated to spend credits sparingly: a fetch starts only when
 * *both* the slow tick cadence is due (`pollEveryNTicks`) **and** the cached
 * value is stale (`cacheTtlMs`). A single in-flight request is deduped, so a
 * burst of concurrent ticks never fans out into parallel calls. An optional
 * credit budget hard-stops new fetches once exhausted (still fail-open).
 */

/** Dependencies for {@link createNansenSignalProvider}. */
export interface NansenProviderDeps {
  /** The underlying single-endpoint client. */
  readonly client: NansenClient;
  /** Start a refresh at most once per this many ticks (slow cadence). */
  readonly pollEveryNTicks: number;
  /** Treat a cached snapshot older than this (ms) as stale and refetchable. */
  readonly cacheTtlMs: number;
  /** Clock for TTL/cadence decisions; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Optional hard cap on total successful-or-attempted fetches (credit budget).
   * Once reached, no new fetch starts. Omit for an unbounded budget.
   */
  readonly maxCalls?: number;
  /** Usage/credit observability sink. Never receives secrets or bodies. */
  readonly logger?: NansenLogger;
}

interface CacheEntry {
  readonly value: NansenSignal;
  readonly storedAtMs: number;
}

/**
 * Construct a {@link NansenSignalProvider}. The provider owns its own cache,
 * cadence, and in-flight state; it is safe to share one instance across the arc.
 */
export function createNansenSignalProvider(deps: NansenProviderDeps): NansenSignalProvider {
  const now = deps.now ?? Date.now;
  const endpointLabel = 'smart-money/netflows';

  let cache: CacheEntry | undefined;
  let inFlight: Promise<void> | undefined;
  let lastPollTick: number | undefined;
  let calls = 0;
  let budgetExhaustedLogged = false;

  /**
   * Emit one observability event. The logger is caller-supplied and may throw
   * (its contract forbids logging secrets, not throwing); isolating it here means
   * a broken sink can never alter control flow, reject the detached fetch, or
   * throw into the synchronous tick path. Logging is best-effort, never load-bearing.
   */
  function log(event: Parameters<NansenLogger>[0]): void {
    try {
      deps.logger?.(event);
    } catch {
      /* a failing observability sink must never affect the arc */
    }
  }

  /** Last *successfully fetched* snapshot — survives later failures (fail-open). */
  function current(): NansenSignal | undefined {
    return cache?.value;
  }

  /** Is the cadence due for `tickIndex`? First tick is always due. */
  function cadenceDue(tickIndex: number): boolean {
    return lastPollTick === undefined || tickIndex - lastPollTick >= deps.pollEveryNTicks;
  }

  /** Is the cache empty or older than its TTL? */
  function cacheStale(): boolean {
    return cache === undefined || now() - cache.storedAtMs >= deps.cacheTtlMs;
  }

  /** The detached fetch body. Never rejects: all failures are swallowed here. */
  async function runFetch(): Promise<void> {
    calls += 1;
    log({ type: 'fetch_start', endpoint: endpointLabel, calls });
    try {
      const value = await deps.client.fetchSignal();
      cache = { value, storedAtMs: now() };
      log({
        type: 'fetch_success',
        endpoint: endpointLabel,
        calls,
        rows: value.netflows.length,
      });
    } catch (err) {
      // Fail-open: keep the last good snapshot; surface only a redacted reason.
      log({
        type: 'fetch_error',
        endpoint: endpointLabel,
        calls,
        reason: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  function maybeRefresh(tickIndex: number): void {
    if (inFlight !== undefined) return; // Dedup: a fetch is already running.
    if (!cadenceDue(tickIndex) || !cacheStale()) return; // Not yet due / still fresh.

    if (deps.maxCalls !== undefined && calls >= deps.maxCalls) {
      if (!budgetExhaustedLogged) {
        budgetExhaustedLogged = true;
        log({ type: 'budget_exhausted', endpoint: endpointLabel, calls });
      }
      return; // Budget spent: hard-stop new fetches, keep serving the cache.
    }

    // Mark the cadence *now* so concurrent ticks during the fetch don't re-arm.
    lastPollTick = tickIndex;
    inFlight = runFetch().finally(() => {
      inFlight = undefined;
    });
    // Detached on purpose: never awaited, never observed by the tick path.
    void inFlight;
  }

  return { current, maybeRefresh };
}
