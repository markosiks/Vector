import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { configSchema } from '@/lib/config/constants.schema';

describe('seeded config — happy path', () => {
  test('validates against its own schema and exposes every domain', () => {
    expect(() => configSchema.parse(CONFIG)).not.toThrow();
    expect(Object.keys(CONFIG).sort()).toEqual([
      'capital',
      'chain',
      'elfa',
      'nansen',
      'policy',
      'router',
      'scoring',
      'timing',
    ]);
  });
});

describe('seeded config — completeness & types', () => {
  test('scoring keys are present with correct numeric types', () => {
    const s = CONFIG.scoring;
    for (const key of [
      'k_perf',
      's_roc',
      'c_floor',
      'b_clean',
      'p_soft',
      'p_hard',
      'p_halt',
      'p_dd',
      'dd_tol',
      'epsilon',
      'alpha',
      'score_0',
      'crash_cap',
    ] as const) {
      expect(typeof s[key]).toBe('number');
      expect(Number.isFinite(s[key])).toBe(true);
    }
  });

  test('penalty asymmetry holds: a hard violation dominates the clean bonus (§6.1)', () => {
    expect(CONFIG.scoring.p_hard).toBeGreaterThan(CONFIG.scoring.b_clean);
    expect(CONFIG.scoring.p_halt).toBeGreaterThanOrEqual(CONFIG.scoring.p_hard);
  });

  test('alpha is a strict EWMA weight in (0, 1) and score_0 is a low prior', () => {
    expect(CONFIG.scoring.alpha).toBeGreaterThan(0);
    expect(CONFIG.scoring.alpha).toBeLessThan(1);
    expect(CONFIG.scoring.score_0).toBeLessThan(CONFIG.router.s_min);
  });

  test('router fractions are within [0, 1] and cooldown is a positive integer', () => {
    expect(CONFIG.router.h).toBeGreaterThanOrEqual(0);
    expect(CONFIG.router.h).toBeLessThanOrEqual(1);
    expect(CONFIG.router.max_step).toBeGreaterThan(0);
    expect(CONFIG.router.max_step).toBeLessThanOrEqual(1);
    expect(Number.isInteger(CONFIG.router.cooldown_ticks)).toBe(true);
  });

  test('signal endpoints are absolute http(s) URLs', () => {
    expect(CONFIG.nansen.endpoint).toMatch(/^https?:\/\//);
    expect(CONFIG.elfa.endpoint).toMatch(/^https?:\/\//);
    expect(CONFIG.chain.mantle_explorer_base_url).toMatch(/^https?:\/\//);
  });

  test('policy whitelist is non-empty and fresh-wallet criteria are present', () => {
    expect(CONFIG.policy.market_whitelist.length).toBeGreaterThan(0);
    expect(CONFIG.policy.fresh_wallet_criteria.max_age_seconds).toBeGreaterThan(0);
    expect(typeof CONFIG.policy.fresh_wallet_criteria.require_zero_history).toBe('boolean');
  });
});

describe('seeded config — cross-field invariants', () => {
  test('crash_cap >= router.s_min is rejected (a floor-crash must stay gated next round)', () => {
    const candidate = {
      ...CONFIG,
      scoring: { ...CONFIG.scoring, crash_cap: CONFIG.router.s_min },
    };
    const result = configSchema.safeParse(candidate);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'scoring.crash_cap')).toBe(true);
    }
  });

  test('score_0 >= router.s_min is rejected (trust is earned, never granted)', () => {
    const candidate = {
      ...CONFIG,
      scoring: { ...CONFIG.scoring, score_0: CONFIG.router.s_min + 1 },
    };
    const result = configSchema.safeParse(candidate);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'scoring.score_0')).toBe(true);
    }
  });

  test('the seeded config satisfies both invariants', () => {
    expect(CONFIG.scoring.crash_cap).toBeLessThan(CONFIG.router.s_min);
    expect(CONFIG.scoring.score_0).toBeLessThan(CONFIG.router.s_min);
  });
});

describe('seeded config — runtime immutability', () => {
  test('mutating a top-level constant throws', () => {
    expect(() => {
      // @ts-expect-error — CONFIG is deeply readonly at the type level.
      CONFIG.scoring.alpha = 0.99;
    }).toThrow();
  });

  test('mutating a nested array throws (deep freeze)', () => {
    expect(() => {
      // @ts-expect-error — readonly array.
      CONFIG.policy.market_whitelist.push('XRP-PERP');
    }).toThrow();
  });

  test('the entire graph is frozen', () => {
    expect(Object.isFrozen(CONFIG)).toBe(true);
    expect(Object.isFrozen(CONFIG.scoring)).toBe(true);
    expect(Object.isFrozen(CONFIG.policy.fresh_wallet_criteria)).toBe(true);
    expect(Object.isFrozen(CONFIG.policy.market_whitelist)).toBe(true);
  });
});

describe('seeded config — single instance', () => {
  test('re-importing yields the same frozen reference', async () => {
    const a = (await import('@/lib/config/constants')).CONFIG;
    const b = (await import('@/lib/config/constants')).CONFIG;
    expect(a).toBe(b);
    expect(a).toBe(CONFIG);
  });
});
