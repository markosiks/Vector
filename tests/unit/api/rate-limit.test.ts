import { describe, expect, test } from 'bun:test';

import { RateLimiter } from '@/lib/api/rate-limit';

/**
 * Regression tests for the in-process sliding-window rate limiter (F-01).
 * Verifies the core behavioral contract without mocking time — all assertions
 * use structurally deterministic outcomes.
 */

describe('RateLimiter', () => {
  test('allows exactly `limit` requests within the window', () => {
    const rl = new RateLimiter({ limit: 3, windowMs: 60_000 });
    expect(rl.check('ip1')).toBe(true);
    expect(rl.check('ip1')).toBe(true);
    expect(rl.check('ip1')).toBe(true);
    // 4th request exceeds the limit
    expect(rl.check('ip1')).toBe(false);
  });

  test('blocks further requests from the same IP once the limit is reached', () => {
    const rl = new RateLimiter({ limit: 2, windowMs: 60_000 });
    expect(rl.check('x')).toBe(true);
    expect(rl.check('x')).toBe(true);
    // All subsequent attempts are blocked
    for (let i = 0; i < 10; i++) {
      expect(rl.check('x')).toBe(false);
    }
  });

  test('different IPs have independent counters', () => {
    const rl = new RateLimiter({ limit: 1, windowMs: 60_000 });
    expect(rl.check('a')).toBe(true);
    expect(rl.check('a')).toBe(false);
    // 'b' has its own fresh window
    expect(rl.check('b')).toBe(true);
    expect(rl.check('b')).toBe(false);
  });

  test('a window of 0 ms immediately expires all hits', async () => {
    const rl = new RateLimiter({ limit: 5, windowMs: 0 });
    // Consume one hit, then wait 1 ms so the window expires.
    rl.check('c');
    await Bun.sleep(1);
    // The old hit is outside the window; the limiter should allow again.
    expect(rl.check('c')).toBe(true);
  });

  test('prune() removes stale entries without affecting active ones', () => {
    const rl = new RateLimiter({ limit: 5, windowMs: 60_000 });
    rl.check('keep');
    rl.prune(); // should not blow up and should keep 'keep' active
    expect(rl.check('keep')).toBe(true); // still within limit
  });

  // Regression (F-01 leak): distinct keys whose hits have all expired must be
  // reclaimed by the amortized sweep in `check`, not accumulate forever (the
  // X-Forwarded-For spoofing DoS vector).
  test('check() reclaims stale keys so the map stays bounded', async () => {
    const rl = new RateLimiter({ limit: 5, windowMs: 10 });
    // Burst of distinct keys within one window: all are retained.
    for (let i = 0; i < 50; i++) rl.check(`ip-${i}`);
    expect(rl.size()).toBe(50);
    // Let the whole window lapse so every recorded hit is now stale.
    await Bun.sleep(15);
    // The next check triggers the once-per-window sweep, dropping all 50 stale
    // entries; only the freshly-touched key remains.
    rl.check('fresh');
    expect(rl.size()).toBe(1);
  });
});
