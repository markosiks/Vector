/**
 * In-process sliding-window rate limiter (F-01).
 *
 * A lightweight, zero-dependency counter keyed on an arbitrary string (e.g. the
 * client IP). Entries are pruned lazily to avoid unbounded memory growth.
 *
 * **Trade-off**: because this lives in the Node.js process heap it resets on
 * every cold start / deployment. For a single-region or low-throughput endpoint
 * like the operator login this is acceptable; a multi-region or high-volume
 * deployment should replace it with a Redis/Upstash edge counter.
 */

interface Window {
  /** Timestamps (ms) of requests within the current window. */
  hits: number[];
}

export interface RateLimiterOptions {
  /** Maximum allowed requests per window. */
  readonly limit: number;
  /** Window size in milliseconds. */
  readonly windowMs: number;
}

export class RateLimiter {
  private readonly map = new Map<string, Window>();
  private readonly limit: number;
  private readonly windowMs: number;
  /** Wall-clock of the last full sweep; gates the amortized prune in `check`. */
  private lastPrune = 0;

  constructor({ limit, windowMs }: RateLimiterOptions) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /**
   * Record a hit for `key` and return whether the request is allowed.
   * Returns `true` when the request is within the limit, `false` when
   * the limit is exceeded (the caller should respond 429).
   */
  check(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    // F-01 hardening: an attacker who can vary the key (e.g. by spoofing
    // X-Forwarded-For) would otherwise add an entry per request that `check`
    // never reclaimed, growing the map without bound until OOM. Sweep stale
    // entries at most once per window so the map stays bounded by the number of
    // *distinct keys seen within a single window* at amortized O(1) per call.
    if (now - this.lastPrune >= this.windowMs) {
      this.pruneBefore(cutoff);
      this.lastPrune = now;
    }

    const existing = this.map.get(key);
    const hits = (existing?.hits ?? []).filter((t) => t > cutoff);

    if (hits.length >= this.limit) {
      this.map.set(key, { hits });
      return false;
    }

    hits.push(now);
    this.map.set(key, { hits });
    return true;
  }

  /** Remove every entry whose hits are all at/older than `cutoff`. */
  private pruneBefore(cutoff: number): void {
    for (const [key, w] of this.map) {
      if (w.hits.length === 0 || w.hits.every((t) => t <= cutoff)) {
        this.map.delete(key);
      }
    }
  }

  /** Remove stale entries (call periodically if many IPs are expected). */
  prune(): void {
    this.pruneBefore(Date.now() - this.windowMs);
  }

  /** Current number of tracked keys. Test/observability only. */
  size(): number {
    return this.map.size;
  }
}
