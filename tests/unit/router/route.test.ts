import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { route } from '@/lib/router/route';
import type { Allocation, PrevAllocation, RouterAgent, RouterConfig } from '@/lib/router/types';

/**
 * Unit coverage for the pure capital router (architecture.txt §6.2). ~10%
 * happy-path; the rest are the anti-oscillation mechanisms, the forced gate-out,
 * the bootstrap, and adversarial / boundary inputs. The load-bearing invariant —
 * `Σ amount == pool_size`, exactly — is asserted on every produced allocation.
 */

const CFG: RouterConfig = { ...CONFIG.router, pool_size: CONFIG.capital.pool_size };
const POOL_UNITS = 10n ** 24n; // 1e6 pool at 18-dp units

/** An agent with the given score; not halted/crashed unless overridden. */
function agent(agentId: string, score: number, over: Partial<RouterAgent> = {}): RouterAgent {
  return { agentId, score, halted: false, crashed: false, ...over };
}

/** Parse an amount string to exact 18-dp integer units. */
function amountUnits(a: string): bigint {
  const [i, f = ''] = a.split('.');
  return BigInt((i ?? '0') + f.padEnd(18, '0').slice(0, 18));
}

/** Assert the allocation conserves the pool exactly and has no negative amount. */
function expectConserved(allocs: readonly Allocation[]): void {
  const total = allocs.reduce((acc, a) => acc + amountUnits(a.amount), 0n);
  expect(total).toBe(POOL_UNITS);
  for (const a of allocs) expect(amountUnits(a.amount) >= 0n).toBe(true);
}

/** Build the next round's `prev` from a previous result's allocations. */
function asPrev(allocs: readonly Allocation[]): PrevAllocation[] {
  return allocs.map((a) => ({ agentId: a.agentId, amount: a.amount, weight: a.target_weight }));
}

/** Weight of an agent in a result, as a number. */
function weightOf(allocs: readonly Allocation[], id: string): number {
  return Number(allocs.find((a) => a.agentId === id)?.target_weight ?? '0');
}

describe('route — happy path', () => {
  test('capital steps toward the leader, conserved, with a recorded delta', () => {
    const agents = [agent('a', 90), agent('b', 50), agent('c', 45)];
    const prev: PrevAllocation[] = agents.map((a) => ({
      agentId: a.agentId,
      amount: '333333.333333333333333333',
      weight: '0.33333333',
    }));
    const { allocations } = route(agents, prev, { tick: 10, cooldownUntilTick: 0 }, CFG, 'settle');

    expectConserved(allocations);
    expect(weightOf(allocations, 'a')).toBeGreaterThan(weightOf(allocations, 'b'));
    expect(weightOf(allocations, 'a')).toBeGreaterThan(1 / 3); // moved up toward the leader
    // delta == target_weight − prev_weight, exactly.
    for (const al of allocations) {
      expect(Number(al.delta)).toBeCloseTo(Number(al.target_weight) - Number(al.prev_weight), 8);
      expect(al.trigger).toBe('settle');
    }
  });
});

describe('route — eligibility gate (step 1)', () => {
  test('an agent below s_min receives no capital', () => {
    const agents = [agent('a', 80), agent('b', CONFIG.router.s_min - 0.01)];
    const { allocations } = route(agents, [], { tick: 0, cooldownUntilTick: 0 }, CFG, 'settle');
    expect(weightOf(allocations, 'b')).toBe(0);
    expect(weightOf(allocations, 'a')).toBeCloseTo(1, 8);
    expectConserved(allocations);
  });

  test('a score exactly at s_min is eligible (gate is ≥, not >)', () => {
    const agents = [agent('a', 80), agent('b', CONFIG.router.s_min)];
    const { allocations } = route(agents, [], { tick: 0, cooldownUntilTick: 0 }, CFG, 'settle');
    expect(weightOf(allocations, 'b')).toBeGreaterThan(0);
  });
});

describe('route — softmax target (step 2)', () => {
  test('equal scores yield an (apportionment-)uniform split', () => {
    const agents = [agent('a', 60), agent('b', 60), agent('c', 60), agent('d', 60)];
    const { allocations } = route(agents, [], { tick: 0, cooldownUntilTick: 0 }, CFG, 'settle');
    for (const a of allocations) expect(Number(a.target_weight)).toBeCloseTo(0.25, 6);
    expectConserved(allocations);
  });

  test('τ → 0 is winner-take-all; τ → ∞ is uniform; both numerically stable', () => {
    const agents = [agent('a', 80), agent('b', 50)];
    const wta = route(
      agents,
      [],
      { tick: 0, cooldownUntilTick: 0 },
      { ...CFG, tau: 1e-9 },
      'settle',
    );
    expect(weightOf(wta.allocations, 'a')).toBeCloseTo(1, 6);
    expect(weightOf(wta.allocations, 'b')).toBeCloseTo(0, 6);

    const uni = route(
      agents,
      [],
      { tick: 0, cooldownUntilTick: 0 },
      { ...CFG, tau: 1e9 },
      'settle',
    );
    expect(weightOf(uni.allocations, 'a')).toBeCloseTo(0.5, 6);
    expectConserved(wta.allocations);
    expectConserved(uni.allocations);
  });

  test('τ → 0 with tied leaders splits evenly between them', () => {
    const agents = [agent('a', 80), agent('b', 80), agent('c', 40)];
    const { allocations } = route(
      agents,
      [],
      { tick: 0, cooldownUntilTick: 0 },
      { ...CFG, tau: 1e-9 },
      'settle',
    );
    expect(weightOf(allocations, 'a')).toBeCloseTo(0.5, 6);
    expect(weightOf(allocations, 'b')).toBeCloseTo(0.5, 6);
    expect(weightOf(allocations, 'c')).toBeCloseTo(0, 6);
  });

  test('a non-positive or non-finite τ throws', () => {
    const agents = [agent('a', 80)];
    expect(() =>
      route(agents, [], { tick: 0, cooldownUntilTick: 0 }, { ...CFG, tau: 0 }, 'settle'),
    ).toThrow(RangeError);
    expect(() =>
      route(agents, [], { tick: 0, cooldownUntilTick: 0 }, { ...CFG, tau: Number.NaN }, 'settle'),
    ).toThrow(RangeError);
  });
});

describe('route — hysteresis (step 3)', () => {
  test('a target move below h is frozen (no reallocation)', () => {
    // prev already ≈ softmax target for these scores ⇒ maxDev < h ⇒ freeze.
    const agents = [agent('a', 55), agent('b', 50), agent('c', 45)];
    const seed = route(agents, [], { tick: 0, cooldownUntilTick: 0 }, CFG, 'settle');
    const prev = asPrev(seed.allocations);
    const settled = route(agents, prev, { tick: 100, cooldownUntilTick: 0 }, CFG, 'settle');
    for (const a of settled.allocations) expect(Number(a.delta)).toBeCloseTo(0, 8);
    expect(settled.state.cooldownUntilTick).toBe(0); // a freeze starts no cooldown
  });

  test('a target move at/above h does reallocate', () => {
    const agents = [agent('a', 90), agent('b', 30)];
    const prev: PrevAllocation[] = [
      { agentId: 'a', amount: '500000.000000000000000000', weight: '0.50000000' },
      { agentId: 'b', amount: '500000.000000000000000000', weight: '0.50000000' },
    ];
    const { allocations } = route(agents, prev, { tick: 100, cooldownUntilTick: 0 }, CFG, 'settle');
    expect(weightOf(allocations, 'a')).toBeGreaterThan(0.5);
    expectConserved(allocations);
  });
});

describe('route — max-step (step 4)', () => {
  test('the relocated fraction is clamped to max_step', () => {
    const agents = [agent('a', 100), agent('b', 0)];
    const prev: PrevAllocation[] = [
      { agentId: 'a', amount: '0.000000000000000000', weight: '0.00000000' },
      { agentId: 'b', amount: '1000000.000000000000000000', weight: '1.00000000' },
    ];
    const { allocations, state } = route(
      agents,
      prev,
      { tick: 100, cooldownUntilTick: 0 },
      CFG,
      'settle',
    );
    const moved = 0.5 * allocations.reduce((acc, a) => acc + Math.abs(Number(a.delta)), 0);
    expect(moved).toBeLessThanOrEqual(CONFIG.router.max_step + 1e-7);
    expect(moved).toBeGreaterThan(CONFIG.router.max_step - 1e-3); // it did move the full cap
    expect(state.cooldownUntilTick).toBe(103); // a clamped move starts a cooldown
  });
});

describe('route — cooldown (step 5)', () => {
  test('a large discretionary move is deferred while in cooldown', () => {
    const agents = [agent('a', 100), agent('b', 0)];
    const prev: PrevAllocation[] = [
      { agentId: 'a', amount: '300000.000000000000000000', weight: '0.30000000' },
      { agentId: 'b', amount: '700000.000000000000000000', weight: '0.70000000' },
    ];
    const { allocations } = route(agents, prev, { tick: 2, cooldownUntilTick: 5 }, CFG, 'settle');
    for (const a of allocations) expect(Number(a.delta)).toBeCloseTo(0, 8); // deferred
    expectConserved(allocations);
  });
});

describe('route — forced gate-out (crash / HALT) bypasses hysteresis & cooldown', () => {
  test('a crashed agent is drained to zero and its capital reroutes immediately', () => {
    const agents = [agent('a', 6, { crashed: true }), agent('b', 58), agent('c', 46)];
    const prev: PrevAllocation[] = [
      { agentId: 'a', amount: '600000.000000000000000000', weight: '0.60000000' },
      { agentId: 'b', amount: '250000.000000000000000000', weight: '0.25000000' },
      { agentId: 'c', amount: '150000.000000000000000000', weight: '0.15000000' },
    ];
    // Deep in cooldown — the gate-out must still fire.
    const { allocations } = route(agents, prev, { tick: 1, cooldownUntilTick: 99 }, CFG, 'settle');
    expect(weightOf(allocations, 'a')).toBe(0);
    expect(weightOf(allocations, 'b') + weightOf(allocations, 'c')).toBeCloseTo(1, 6);
    expect(weightOf(allocations, 'b')).toBeGreaterThan(weightOf(allocations, 'c'));
    expectConserved(allocations);
  });

  test('an operator-halted agent is gated out even on a settle trigger', () => {
    const agents = [agent('a', 80, { halted: true }), agent('b', 70)];
    const prev: PrevAllocation[] = [
      { agentId: 'a', amount: '500000.000000000000000000', weight: '0.50000000' },
      { agentId: 'b', amount: '500000.000000000000000000', weight: '0.50000000' },
    ];
    const { allocations } = route(agents, prev, { tick: 1, cooldownUntilTick: 99 }, CFG, 'settle');
    expect(weightOf(allocations, 'a')).toBe(0);
    expect(weightOf(allocations, 'b')).toBeCloseTo(1, 6);
  });
});

describe('route — round-0 bootstrap', () => {
  test('cold start with nobody eligible splits the pool equally across seed agents', () => {
    const agents = [
      agent('a', CONFIG.scoring.score_0),
      agent('b', CONFIG.scoring.score_0),
      agent('c', CONFIG.scoring.score_0),
    ];
    const { allocations, state } = route(
      agents,
      [],
      { tick: 0, cooldownUntilTick: 0 },
      CFG,
      'settle',
    );
    for (const a of allocations) expect(Number(a.target_weight)).toBeCloseTo(1 / 3, 6);
    expectConserved(allocations);
    expect(state.cooldownUntilTick).toBe(3); // the fill starts a cooldown
  });

  test('cold start with eligible agents fills straight to the softmax target', () => {
    const agents = [agent('a', 90), agent('b', 40)];
    const { allocations } = route(agents, [], { tick: 0, cooldownUntilTick: 0 }, CFG, 'settle');
    // Not rate-limited by max_step on the first fill from an empty pool.
    expect(weightOf(allocations, 'a')).toBeGreaterThan(0.5 + CONFIG.router.max_step);
    expectConserved(allocations);
  });
});

describe('route — cooldownUntilTick is never shortened by a forced move (R-02 regression)', () => {
  test('a forced move occurring during a longer cooldown does not shorten it', () => {
    // R-02: cooldownUntilTick was always set to state.tick + cooldown_ticks on a
    // largeMove, with no max() guard. A forced move at tick T when an already-longer
    // cooldown (e.g. until tick T+C+10) was active would shorten it to T+C.
    // Fix: Math.max(state.cooldownUntilTick, state.tick + cooldown_ticks).
    const agents = [
      agent('a', 80),
      agent('b', 60, { crashed: true }), // forced gate-out triggers largeMove
    ];
    const prev: PrevAllocation[] = [
      { agentId: 'a', amount: '500000.000000000000000000', weight: '0.50000000' },
      { agentId: 'b', amount: '500000.000000000000000000', weight: '0.50000000' },
    ];
    // The existing cooldown expires at tick 999; cooldown_ticks is much smaller.
    const existingCooldown = 999;
    const { state } = route(agents, prev, { tick: 10, cooldownUntilTick: existingCooldown }, CFG, 'crash');
    // The forced move must NOT shorten the active cooldown.
    expect(state.cooldownUntilTick).toBeGreaterThanOrEqual(existingCooldown);
  });

  test('a largeMove on a fresh state extends the cooldown normally', () => {
    const agents = [agent('a', 80), agent('b', 60)];
    const { state } = route(agents, [], { tick: 5, cooldownUntilTick: 0 }, CFG, 'settle');
    // Cold start ⇒ largeMove ⇒ cooldown set to tick + cooldown_ticks.
    expect(state.cooldownUntilTick).toBe(5 + CFG.cooldown_ticks);
  });
});

describe('route — edge cases and invariants', () => {
  test('no agents yields no allocations and leaves state untouched', () => {
    const state = { tick: 5, cooldownUntilTick: 9 };
    const r = route([], [], state, CFG, 'settle');
    expect(r.allocations).toEqual([]);
    expect(r.state).toBe(state);
  });

  test('all agents below s_min holds capital with the live survivors', () => {
    const agents = [agent('a', 10), agent('b', 10)];
    const prev: PrevAllocation[] = [
      { agentId: 'a', amount: '700000.000000000000000000', weight: '0.70000000' },
      { agentId: 'b', amount: '300000.000000000000000000', weight: '0.30000000' },
    ];
    const { allocations } = route(agents, prev, { tick: 1, cooldownUntilTick: 0 }, CFG, 'settle');
    // Held proportionally to their prior shares; pool conserved.
    expect(weightOf(allocations, 'a')).toBeCloseTo(0.7, 6);
    expectConserved(allocations);
  });

  test('only one eligible agent receives the whole pool', () => {
    const agents = [agent('a', 80), agent('b', 10), agent('c', 5)];
    const { allocations } = route(agents, [], { tick: 0, cooldownUntilTick: 0 }, CFG, 'settle');
    expect(weightOf(allocations, 'a')).toBeCloseTo(1, 8);
    expectConserved(allocations);
  });

  test('a non-finite score throws', () => {
    expect(() =>
      route([agent('a', Number.NaN)], [], { tick: 0, cooldownUntilTick: 0 }, CFG, 'settle'),
    ).toThrow(RangeError);
  });

  test('a negative prev amount or weight throws instead of skewing the baseline', () => {
    // Regression: the prior comes from the ledger (CHECK >= 0). A negative value
    // is a corrupted row; letting it through skewed `prevSum`/`prevW` (or forced
    // a false cold start when negatives cancelled) and corrupted the move policy.
    const agents = [agent('a', 80), agent('b', 60)];
    const negAmount: PrevAllocation[] = [
      { agentId: 'a', amount: '-100.0', weight: '0.50000000' },
      { agentId: 'b', amount: '100.0', weight: '0.50000000' },
    ];
    expect(() =>
      route(agents, negAmount, { tick: 5, cooldownUntilTick: 0 }, CFG, 'settle'),
    ).toThrow(RangeError);

    const negWeight: PrevAllocation[] = [
      { agentId: 'a', amount: '500000.0', weight: '-0.50000000' },
      { agentId: 'b', amount: '500000.0', weight: '0.50000000' },
    ];
    expect(() =>
      route(agents, negWeight, { tick: 5, cooldownUntilTick: 0 }, CFG, 'settle'),
    ).toThrow(RangeError);
  });

  test('settle is idempotent: re-running with the same inputs yields the same output', () => {
    const agents = [agent('a', 80), agent('b', 55), agent('c', 40)];
    const prev: PrevAllocation[] = agents.map((a) => ({
      agentId: a.agentId,
      amount: '333333.333333333333333333',
      weight: '0.33333333',
    }));
    const state = { tick: 50, cooldownUntilTick: 0 };
    const a = route(agents, prev, state, CFG, 'settle');
    const b = route(agents, prev, state, CFG, 'settle');
    expect(a).toEqual(b);
    // And re-applying to its own (settled) output does not move further.
    const c = route(
      agents,
      asPrev(a.allocations),
      { tick: 60, cooldownUntilTick: 0 },
      CFG,
      'settle',
    );
    const moved = 0.5 * c.allocations.reduce((acc, x) => acc + Math.abs(Number(x.delta)), 0);
    expect(moved).toBeLessThanOrEqual(CONFIG.router.max_step + 1e-7);
  });

  test('an agent added between rounds starts from zero; a removed one is reabsorbed', () => {
    const r0 = route(
      [agent('a', 80), agent('b', 60)],
      [],
      { tick: 0, cooldownUntilTick: 0 },
      CFG,
      'settle',
    );
    // Round 1: 'b' vanishes, 'c' appears. Conservation must still hold.
    const agents1 = [agent('a', 80), agent('c', 70)];
    const r1 = route(
      agents1,
      asPrev(r0.allocations),
      { tick: 10, cooldownUntilTick: 0 },
      CFG,
      'settle',
    );
    expect(r1.allocations.map((a) => a.agentId).sort()).toEqual(['a', 'c']);
    expectConserved(r1.allocations);
  });
});
