import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { signIntent } from '@/lib/intent/sign';
import { validateIntent, type ValidationStage } from '@/lib/intent/validate';
import { VALIDATION_STAGES } from '@/lib/intent/onboarding';
import { evaluate } from '@/lib/referee';
import type { RefereeState } from '@/lib/referee/types';
import { resolveTestSigner, TEST_PK, validOpenInput } from '@/tests/fixtures/intent-fixtures';

/**
 * Fuzz the onboarding conformance surface (P3.3 §10): an external emitter sends
 * arbitrary, often-broken Intents. Invariants under any input:
 *  - `validateIntent` always resolves to a typed result and never throws (B1);
 *  - a rejection always names a documented {@link ValidationStage};
 *  - the unmutated, correctly-signed control always validates.
 * Determinism is controlled with a seeded PRNG so any failure reproduces exactly.
 */

/** mulberry32 — small deterministic PRNG (matches the repo's fuzz convention). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STAGES = new Set<ValidationStage>(VALIDATION_STAGES);

type Mutation = (intent: Record<string, unknown>, r: () => number) => void;

const MUTATIONS: readonly Mutation[] = [
  (i) => delete i.market, // missing required field → schema
  (i) => delete i.signature, // unsigned wire shape → schema
  (i, r) => (i[`x_${Math.floor(r() * 1e6)}`] = 'extra'), // unknown key → schema (.strict)
  (i) => (i.action = 'frobnicate'), // bad discriminant → schema
  (i) => (i.signature = '0xdead'), // malformed signature → schema
  (i) => (i.signature = `0x${'b'.repeat(130)}`), // wrong (well-formed) sig → signature
  (i) => (i.ttl = '2000-01-01T00:00:00.000Z'), // expired → ttl
  (i) => (i.ttl = 'not-a-date'), // bad timestamp → schema
  (i) => (i.size = -5), // nonpositive → bounds
  (i) => (i.max_slippage = 2), // out of [0,1] → bounds
  (i) => (i.market = 'NOT-WHITELISTED'), // structurally valid; referee rejects
  (i) => (i.target_address = '0x000000000000000000000000000000000000dEaD'), // illegal on open → target_address
];

describe('onboarding fuzz — validateIntent is total and only fails at documented stages', () => {
  test('arbitrary mutated external Intents never throw and reject only at known stages', async () => {
    const r = rng(0xc0ffee);
    for (let n = 0; n < 400; n += 1) {
      // A correctly-signed base, then mutated post-signing into an "external" wire object.
      const base = await signIntent(validOpenInput({ nonce: String(n) }), TEST_PK);
      const wire = { ...base } as Record<string, unknown>;
      const count = 1 + Math.floor(r() * 3);
      for (let m = 0; m < count; m += 1) {
        MUTATIONS[Math.floor(r() * MUTATIONS.length)]!(wire, r);
      }

      const result = await validateIntent(wire, {
        resolveSigner: resolveTestSigner,
        now: new Date(),
      });

      expect(typeof result.ok).toBe('boolean');
      if (!result.ok) {
        expect(STAGES.has(result.stage)).toBe(true);
        expect(typeof result.code).toBe('string');
        expect(result.code.length).toBeGreaterThan(0);
      }
    }
  });

  test('the unmutated, correctly-signed control always validates', async () => {
    const signed = await signIntent(validOpenInput(), TEST_PK);
    const result = await validateIntent(signed, {
      resolveSigner: resolveTestSigner,
      now: new Date(),
    });
    expect(result.ok).toBe(true);
  });

  test('referee evaluation is total over validated Intents (no panic)', async () => {
    const r = rng(0x1234);
    const state: RefereeState = {
      killSwitch: { active: false },
      agent: { allocation: '100000', remaining_budget: '100000', drawdown: '0' },
    };
    for (let n = 0; n < 100; n += 1) {
      const market = r() < 0.5 ? 'BTC-PERP' : `RAND-${Math.floor(r() * 1e4)}`;
      const signed = await signIntent(validOpenInput({ nonce: String(n), market }), TEST_PK);
      const result = await validateIntent(signed, { resolveSigner: resolveTestSigner });
      if (!result.ok) continue;
      const decision = evaluate(result.intent, state, CONFIG.policy);
      expect(['ALLOW', 'CLIP', 'REJECT', 'HALT']).toContain(decision.decision);
    }
  });
});
