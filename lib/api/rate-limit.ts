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

    let w = this.map.get(key);
    if (w === undefined) {
      w = { hits: [] };
      this.map.set(key, w);
    }

    // Slide: drop timestamps older than the window.
    w.hits = w.hits.filter((t) => t > cutoff);

    if (w.hits.length >= this.limit) {
      return false;
    }

    w.hits.push(now);
    return true;
  }

  /** Remove stale entries (call periodically if many IPs are expected). */
  prune(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, w] of this.map) {
      if (w.hits.every((t) => t <= cutoff)) {
        this.map.delete(key);
      }
    }
  }
}
