import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { configSchema, scoringSchema } from '@/lib/config/constants.schema';

/**
 * Property: the config schema is the gatekeeper of consistency. Arbitrary
 * overrides of `scoring` either parse into a value that satisfies every
 * invariant, or are rejected — never accepted in a half-valid state. Pathological
 * numbers (NaN, ±Infinity, negatives) must be rejected where disallowed.
 */

const PATHOLOGICAL = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.0001];

describe('config schema — pathological scoring values are rejected', () => {
  for (const bad of PATHOLOGICAL) {
    test(`alpha=${bad} is rejected (must be in open (0,1))`, () => {
      const candidate = { ...CONFIG.scoring, alpha: bad };
      expect(scoringSchema.safeParse(candidate).success).toBe(false);
    });

    test(`epsilon=${bad} is rejected (must be positive & finite)`, () => {
      const candidate = { ...CONFIG.scoring, epsilon: bad };
      expect(scoringSchema.safeParse(candidate).success).toBe(false);
    });
  }

  test('alpha at the open-interval boundaries (0 and 1) is rejected', () => {
    expect(scoringSchema.safeParse({ ...CONFIG.scoring, alpha: 0 }).success).toBe(false);
    expect(scoringSchema.safeParse({ ...CONFIG.scoring, alpha: 1 }).success).toBe(false);
  });
});

describe('config schema — fuzzed numeric overrides stay consistent or rejected', () => {
  test('500 random alpha values: accepted ⟺ within (0,1) and finite', () => {
    for (let i = 0; i < 500; i += 1) {
      // Range deliberately spans outside (0,1) and includes non-finite picks.
      const roll = Math.sin(i * 97.13) * 4; // deterministic spread in ~[-4,4]
      const alpha = i % 37 === 0 ? Number.NaN : roll;
      const ok = scoringSchema.safeParse({ ...CONFIG.scoring, alpha }).success;
      const shouldBeOk = Number.isFinite(alpha) && alpha > 0 && alpha < 1;
      expect(ok).toBe(shouldBeOk);
    }
  });
});

describe('config schema — structural integrity', () => {
  test('an unknown extra domain key is stripped, not retained', () => {
    const parsed = configSchema.parse({
      ...CONFIG,
      bogus: { whatever: 1 },
    } as unknown);
    expect(Object.keys(parsed)).not.toContain('bogus');
  });

  test('an empty market whitelist is rejected (nonempty invariant)', () => {
    const candidate = {
      ...CONFIG,
      policy: { ...CONFIG.policy, market_whitelist: [] },
    };
    expect(configSchema.safeParse(candidate).success).toBe(false);
  });
});
