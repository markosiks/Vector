import { ElfaRateLimitError } from './client';
import type { ElfaClient } from './client';
import type { ElfaLogger, ElfaSignal, ElfaSignalProvider } from './types';

/**
 * The caching, slow-polling provider that fronts an {@link ElfaClient} (P3.1).
 *
 * It enforces the invariants the orchestrator depends on:
 *  1. **The tick never blocks on the network.** {@link ElfaSignalProvider.current}
 *     returns a value synchronously; {@link ElfaSignalProvider.maybeRefresh} only
 *     ever *starts* a detached fetch and returns at once.
 *  2. **A value is always available.** `current()` returns the last live snapshot
 *     when one exists, otherwise the seeded `mock`. It is **never `undefined`**,
 *     so `context.signals.elfa` is always populated.
 *  3. **Fail-open.** Any client failure (timeout, 429, 402, 5xx, bad JSON) is
 *     swallowed; the last good value (live snapshot or mock) stays in place, so a
 *     broken or absent Elfa never stalls or corrupts the arc.
 *
 * Mode is decided by whether a `client` is wired. With **no client** the provider
 * is mock-only: `maybeRefresh` is a no-op and `current()` always returns the
 * mock — fully deterministic and safe to wire into the default arc. With a
 * `client` it polls live on a doubly-gated cadence (both `pollEveryNTicks` due
 * **and** `cacheTtlMs` stale), dedups a single in-flight request, and optionally
 * hard-stops at a `maxCalls` credit budget.
 */

/** Dependencies for {@link createElfaSignalProvider}. */
export interface ElfaProviderDeps {
  /** The deterministic seeded snapshot served whenever no live value exists. */
  readonly mock: ElfaSignal;
  /**
   * The underlying single-endpoint live client. Omit (or `undefined`) for
   * mock-only mode: no network is ever touched and `current()` returns `mock`.
   */
  readonly client?: ElfaClient;
  /** Start a refresh at most once per this many ticks (slow cadence). */
  readonly pollEveryNTicks: number;
  /** Treat a cached live snapshot older than this (ms) as stale and refetchable. */
  readonly cacheTtlMs: number;
  /** Clock for TTL/cadence decisions; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Optional hard cap on total successful-or-attempted fetches (credit budget).
   * Once reached, no new fetch starts. Omit for an unbounded budget.
   */
  readonly maxCalls?: number;
  /** Usage/credit observability sink. Never receives secrets or bodies. */
  readonly logger?: ElfaLogger;
}

interface CacheEntry {
  readonly value: ElfaSignal;
  readonly storedAtMs: number;
}

/**
 * Construct an {@link ElfaSignalProvider}. The provider owns its own cache,
 * cadence, and in-flight state; it is safe to share one instance across the arc.
 */
/**
 * Total error-name extractor for the detached fail-open path. Reading `.name`
 * off an exotic thrown value (e.g. a Proxy with a throwing getter) could itself
 * throw; this swallows that so the detached `runFetch` can never reject.
 */
function errorName(err: unknown): string {
  try {
    return err instanceof Error ? err.name : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function createElfaSignalProvider(deps: ElfaProviderDeps): ElfaSignalProvider {
  const now = deps.now ?? Date.now;
  const endpointLabel = 'aggregations/trending-tokens';

  let cache: CacheEntry | undefined;
  let inFlight: Promise<void> | undefined;
  let lastPollTick: number | undefined;
  let calls = 0;
  let budgetExhaustedLogged = false;
  /** Earliest wall-clock instant at which the cadence gate may fire again (rate-limit backoff). */
  let rateLimitUntilMs = 0;

  /**
   * Emit one observability event. The logger is caller-supplied and may throw
   * (its contract forbids logging secrets, not throwing); isolating it here means
   * a broken sink can never alter control flow, reject the detached fetch, or
   * throw into the synchronous tick path. Logging is best-effort, never load-bearing.
   */
  function log(event: Parameters<ElfaLogger>[0]): void {
    try {
      deps.logger?.(event);
    } catch {
      /* a failing observability sink must never affect the arc */
    }
  }

  /** Always returns a value: the last live snapshot, or the seeded mock. */
  function current(): ElfaSignal {
    return cache?.value ?? deps.mock;
  }

  function mode(): 'live' | 'mock' {
    return deps.client === undefined ? 'mock' : 'live';
  }

  /** Is the cadence due for `tickIndex`? First tick is always due. Respects rate-limit backoff. */
  function cadenceDue(tickIndex: number): boolean {
    if (now() < rateLimitUntilMs) return false; // still in Retry-After window
    return lastPollTick === undefined || tickIndex - lastPollTick >= deps.pollEveryNTicks;
  }

  /** Is the live cache empty or older than its TTL? */
  function cacheStale(): boolean {
    return cache === undefined || now() - cache.storedAtMs >= deps.cacheTtlMs;
  }

  /** The detached fetch body. Never rejects: all failures are swallowed here. */
  async function runFetch(client: ElfaClient): Promise<void> {
    calls += 1;
    log({ type: 'fetch_start', endpoint: endpointLabel, calls });
    try {
      const value = await client.fetchSignal();
      cache = { value, storedAtMs: now() };
      log({
        type: 'fetch_success',
        endpoint: endpointLabel,
        calls,
        rows: value.sentiments.length,
      });
    } catch (err) {
      // Fail-open: keep the last good value (live or mock); surface a redacted reason.
      // `errorName` is total — this catch must never throw (the fetch is detached,
      // so a throw here would become an unhandled rejection).
      if (err instanceof ElfaRateLimitError && err.retryAfterMs !== undefined) {
        // Respect the upstream's Retry-After: block the cadence gate until the
        // requested backoff has elapsed, so we don't burn credits re-polling.
        rateLimitUntilMs = now() + err.retryAfterMs;
      }
      log({
        type: 'fetch_error',
        endpoint: endpointLabel,
        calls,
        reason: errorName(err),
      });
    }
  }

  function maybeRefresh(tickIndex: number): void {
    const client = deps.client;
    if (client === undefined) return; // Mock-only: never touch the network.
    if (inFlight !== undefined) return; // Dedup: a fetch is already running.
    if (!cadenceDue(tickIndex) || !cacheStale()) return; // Not yet due / still fresh.

    if (deps.maxCalls !== undefined && calls >= deps.maxCalls) {
      if (!budgetExhaustedLogged) {
        budgetExhaustedLogged = true;
        log({ type: 'budget_exhausted', endpoint: endpointLabel, calls });
      }
      return; // Budget spent: hard-stop new fetches, keep serving the cache/mock.
    }

    // Mark the cadence *now* so concurrent ticks during the fetch don't re-arm.
    lastPollTick = tickIndex;
    inFlight = runFetch(client).finally(() => {
      inFlight = undefined;
    });
    // Detached on purpose: never awaited, never observed by the tick path.
    void inFlight;
  }

  return { current, maybeRefresh, mode };
}
