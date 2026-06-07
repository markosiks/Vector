import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { route } from '@/lib/router/route';
import type {
  Allocation,
  PrevAllocation,
  RouterAgent,
  RouterConfig,
  RouterState,
} from '@/lib/router/types';

/**
 * End-to-end stress for the capital router: long deterministic simulations that
 * exercise the policy as a whole — no-drift over thousands of rounds, attempted
 * oscillation, simultaneous crashes, config extremes, and trigger churn. These
 * are pure (no DB), so they verify behavior, not plumbing.
 */

const CFG: RouterConfig = { ...CONFIG.router, pool_size: CONFIG.capital.pool_size };
const POOL_UNITS = 10n ** 24n;

function amountUnits(a: string): bigint {
  const [i, f = ''] = a.split('.');
  return BigInt((i ?? '0') + f.padEnd(18, '0').slice(0, 18));
}
function totalUnits(allocs: readonly Allocation[]): bigint {
  return allocs.reduce((acc, a) => acc + amountUnits(a.amount), 0n);
}
function asPrev(allocs: readonly Allocation[]): PrevAllocation[] {
  return allocs.map((a) => ({ agentId: a.agentId, amount: a.amount, weight: a.target_weight }));
}
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('router e2e — no drift over thousands of rounds', () => {
  test('5000 rounds of churning scores never lose or mint a single unit', () => {
    const r = rng(0xd1f7);
    const ids = ['a', 'b', 'c', 'd', 'e'];
    let prev: PrevAllocation[] = [];
    let state: RouterState = { tick: 0, cooldownUntilTick: 0 };
    for (let round = 0; round < 5000; round += 1) {
      const agents: RouterAgent[] = ids.map((id) => ({
        agentId: id,
        score: 30 + r() * 70,
        halted: false,
        crashed: false,
      }));
      const res = route(agents, prev, state, CFG, 'settle');
      expect(totalUnits(res.allocations)).toBe(POOL_UNITS); // exact, every round
      prev = asPrev(res.allocations);
      state = { tick: state.tick + 1, cooldownUntilTick: res.state.cooldownUntilTick };
    }
  });
});

describe('router e2e — oscillation resistance', () => {
  test('scores that flip-flop never make the leader oscillate faster than the cap', () => {
    // Two agents whose scores swap every tick; max-step + cooldown must damp it.
    const r = ['a', 'b'];
    let prev: PrevAllocation[] = [];
    let state: RouterState = { tick: 0, cooldownUntilTick: 0 };
    let prevLeaderWeight = 0.5;
    let maxSwing = 0;
    for (let tick = 0; tick < 200; tick += 1) {
      const high = tick % 2 === 0 ? 90 : 40;
      const low = tick % 2 === 0 ? 40 : 90;
      const agents: RouterAgent[] = [
        { agentId: r[0] as string, score: high, halted: false, crashed: false },
        { agentId: r[1] as string, score: low, halted: false, crashed: false },
      ];
      const res = route(agents, prev, state, CFG, 'settle');
      expect(totalUnits(res.allocations)).toBe(POOL_UNITS);
      const w = Number(res.allocations[0]?.target_weight ?? '0');
      if (tick > 0) maxSwing = Math.max(maxSwing, Math.abs(w - prevLeaderWeight));
      prevLeaderWeight = w;
      prev = asPrev(res.allocations);
      state = { tick: state.tick + 1, cooldownUntilTick: res.state.cooldownUntilTick };
    }
    // A single agent's per-tick weight change is bounded by the relocation cap.
    expect(maxSwing).toBeLessThanOrEqual(CFG.max_step + 1e-6);
  });
});

describe('router e2e — simultaneous crashes', () => {
  test('two leaders crashing at once drain together and capital flows to the survivor', () => {
    const agents0: RouterAgent[] = [
      { agentId: 'a', score: 90, halted: false, crashed: false },
      { agentId: 'b', score: 85, halted: false, crashed: false },
      { agentId: 'c', score: 60, halted: false, crashed: false },
    ];
    // Establish a funded allocation first (cold-start fill).
    const seed = route(agents0, [], { tick: 0, cooldownUntilTick: 0 }, CFG, 'settle');

    const agents1: RouterAgent[] = [
      { agentId: 'a', score: 6, halted: false, crashed: true },
      { agentId: 'b', score: 6, halted: false, crashed: true },
      { agentId: 'c', score: 60, halted: false, crashed: false },
    ];
    const res = route(
      agents1,
      asPrev(seed.allocations),
      { tick: 1, cooldownUntilTick: 99 },
      CFG,
      'crash',
    );
    expect(totalUnits(res.allocations)).toBe(POOL_UNITS);
    expect(Number(res.allocations.find((a) => a.agentId === 'a')?.amount)).toBe(0);
    expect(Number(res.allocations.find((a) => a.agentId === 'b')?.amount)).toBe(0);
    // The lone survivor absorbs the entire pool.
    expect(Number(res.allocations.find((a) => a.agentId === 'c')?.target_weight)).toBeCloseTo(1, 6);
  });

  test('every agent crashing parks the pool without minting or losing units', () => {
    const agents0: RouterAgent[] = [
      { agentId: 'a', score: 80, halted: false, crashed: false },
      { agentId: 'b', score: 70, halted: false, crashed: false },
    ];
    const seed = route(agents0, [], { tick: 0, cooldownUntilTick: 0 }, CFG, 'settle');
    const agents1: RouterAgent[] = agents0.map((a) => ({ ...a, crashed: true, score: 5 }));
    const res = route(
      agents1,
      asPrev(seed.allocations),
      { tick: 1, cooldownUntilTick: 0 },
      CFG,
      'crash',
    );
    expect(totalUnits(res.allocations)).toBe(POOL_UNITS); // conserved even in the degenerate state
  });
});

describe('router e2e — config extremes', () => {
  test('τ, max_step and h at their boundaries stay conserved and finite', () => {
    const agents: RouterAgent[] = [
      { agentId: 'a', score: 95, halted: false, crashed: false },
      { agentId: 'b', score: 60, halted: false, crashed: false },
      { agentId: 'c', score: 35, halted: false, crashed: false },
    ];
    const prev: PrevAllocation[] = agents.map((a) => ({
      agentId: a.agentId,
      amount: '333333.333333333333333333',
      weight: '0.33333333',
    }));
    const extremes: Partial<RouterConfig>[] = [
      { tau: 1e-9 }, // winner-take-all
      { tau: 1e9 }, // uniform
      { max_step: 1 }, // no rate limit
      { max_step: 1e-9 }, // glacial
      { h: 0 }, // no hysteresis band
      { h: 1 }, // freeze almost everything
      { cooldown_ticks: 0 }, // no cooldown
    ];
    for (const over of extremes) {
      const res = route(
        agents,
        prev,
        { tick: 100, cooldownUntilTick: 0 },
        { ...CFG, ...over },
        'settle',
      );
      expect(totalUnits(res.allocations)).toBe(POOL_UNITS);
      for (const a of res.allocations) {
        expect(Number.isFinite(Number(a.target_weight))).toBe(true);
        expect(Number(a.target_weight) >= 0).toBe(true);
      }
    }
  });
});

describe('router e2e — trigger churn and membership changes', () => {
  test('a long run mixing triggers and adding/removing agents always conserves', () => {
    const r = rng(0xfa11);
    const triggers = ['settle', 'attestation', 'crash', 'operator'] as const;
    let prev: PrevAllocation[] = [];
    let state: RouterState = { tick: 0, cooldownUntilTick: 0 };
    for (let round = 0; round < 1500; round += 1) {
      // Membership drifts: 2–6 agents drawn from a rotating pool.
      const n = 2 + Math.floor(r() * 5);
      const agents: RouterAgent[] = Array.from({ length: n }, (_, k) => ({
        agentId: `a${(round + k) % 8}`, // ids enter and leave between rounds
        score: r() * 110 - 5,
        halted: r() < 0.08,
        crashed: r() < 0.08,
      }));
      // Dedup by id (a round has at most one row per agent).
      const seen = new Set<string>();
      const unique = agents.filter((a) =>
        seen.has(a.agentId) ? false : (seen.add(a.agentId), true),
      );
      const trigger = triggers[Math.floor(r() * triggers.length)] ?? 'settle';
      const res = route(unique, prev, state, CFG, trigger);
      expect(totalUnits(res.allocations)).toBe(POOL_UNITS);
      prev = asPrev(res.allocations);
      state = { tick: state.tick + 1, cooldownUntilTick: res.state.cooldownUntilTick };
    }
  });
});
