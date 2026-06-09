import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import {
  SEED_CONTRARIAN_ID,
  SEED_FEATHERWEIGHT_ID,
  SEED_LEADER_ID,
  SEED_RUNNER_UP_ID,
} from '@/lib/agents/seed';
import { buildDemoArc, DEMO_ARC, DEMO_ROUNDS } from '@/seed';

import golden from '@/tests/fixtures/seed-arc-golden.json';

/**
 * Golden regression for the frozen demo dataset (§6.5). A fixed seed
 * `(version, rounds, timing)` must always materialize the *same* arc — the
 * dataset is the determinism anchor — so a small `rounds=2` arc is pinned
 * bit-for-bit, and the full default arc's invariants (length, attack timing,
 * agent roster) are asserted. Regenerate the fixture intentionally (review the
 * diff) only when the dataset version changes.
 */

describe('buildDemoArc — golden dataset', () => {
  test('a rounds=2 arc matches the recorded fixture bit-for-bit', () => {
    expect(buildDemoArc({ rounds: 2 })).toEqual(golden as never);
  });

  test('rebuilds are byte-identical (no clock, no randomness)', () => {
    expect(JSON.stringify(buildDemoArc())).toBe(JSON.stringify(buildDemoArc()));
  });
});

describe('DEMO_ARC — default arc invariants', () => {
  const tpr = CONFIG.timing.ticks_per_round;

  test('spans DEMO_ROUNDS rounds of ticks_per_round ticks', () => {
    expect(DEMO_ARC.totalTicks).toBe(DEMO_ROUNDS * tpr);
    expect(DEMO_ARC.agentIds).toEqual([
      SEED_LEADER_ID,
      SEED_RUNNER_UP_ID,
      SEED_FEATHERWEIGHT_ID,
      SEED_CONTRARIAN_ID,
    ]);
    for (const id of DEMO_ARC.agentIds) {
      expect(DEMO_ARC.outcomes[id]).toHaveLength(DEMO_ARC.totalTicks);
    }
    expect(DEMO_ARC.ticks).toHaveLength(DEMO_ARC.totalTicks);
  });

  test('attack lands on the penultimate round settle, targeting the leader', () => {
    // Settle tick of the second-to-last round: a follow-on round exists to
    // receive the rerouted capital.
    expect(DEMO_ARC.attack.atTick).toBe(DEMO_ARC.totalTicks - tpr - 1);
    expect((DEMO_ARC.attack.atTick + 1) % tpr).toBe(0); // it *is* a settle tick
    expect(DEMO_ARC.attack.targetAgentId).toBe(SEED_LEADER_ID);
  });

  test('rejects a non-positive round count', () => {
    expect(() => buildDemoArc({ rounds: 0 })).toThrow(/positive integer/);
  });
});
