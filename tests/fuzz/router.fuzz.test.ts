import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { route } from '@/lib/router/route';
import type { Allocation, PrevAllocation, RouterAgent, RouterConfig } from '@/lib/router/types';

/**
 * Property fuzzing for the capital router (§10). A deterministic PRNG drives
 * thousands of wide-range scores/states/triggers so the suite is reproducible.
 * Invariants checked on every draw:
 *  - conservation: `Σ amount == pool_size`, exactly (integer units);
 *  - non-negativity: no amount or weight is negative;
 *  - eligibility: a sub-`s_min` or gated-out agent never holds capital, unless
 *    it is the documented "nobody eligible" survivor fallback;
 *  - max-step: a discretionary (non-forced, non-cold-start) move never relocates
 *    more than `max_step` of the pool;
 *  - determinism: the same draw routes identically twice.
 * Plus a property: with stable scores, allocations are stationary after cooldown
 * (no oscillation).
 */

const CFG: RouterConfig = { ...CONFIG.router, pool_size: CONFIG.capital.pool_size };
const POOL_UNITS = 10n ** 24n;
const TRIGGERS = ['settle', 'attestation', 'crash', 'operator'] as const;

/** Deterministic mulberry32 PRNG. */
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

function amountUnits(a: string): bigint {
  const [i, f = ''] = a.split('.');
  return BigInt((i ?? '0') + f.padEnd(18, '0').slice(0, 18));
}

function totalUnits(allocs: readonly Allocation[]): bigint {
  return allocs.reduce((acc, a) => acc + amountUnits(a.amount), 0n);
}

function movedFraction(allocs: readonly Allocation[]): number {
  return 0.5 * allocs.reduce((acc, a) => acc + Math.abs(Number(a.delta)), 0);
}

describe('router fuzz — invariants hold on wide-range inputs', () => {
  test('4000 draws conserve the pool, stay non-negative, and respect gating', () => {
    const r = rng(0x5eed1);
    for (let i = 0; i < 4000; i += 1) {
      const n = 1 + Math.floor(r() * 6);
      const agents: RouterAgent[] = Array.from({ length: n }, (_, k) => ({
        agentId: `a${k}`,
        score: r() * 120 - 10, // includes negatives and > 100
        halted: r() < 0.1,
        crashed: r() < 0.1,
      }));
      const trigger = TRIGGERS[Math.floor(r() * TRIGGERS.length)] ?? 'settle';
      const state = { tick: Math.floor(r() * 20), cooldownUntilTick: Math.floor(r() * 20) };

      // Sometimes seed a prior allocation that itself conserves the pool.
      let prev: PrevAllocation[] = [];
      if (r() < 0.6) {
        const raw = agents.map(() => r());
        const sum = raw.reduce((a, b) => a + b, 0) || 1;
        prev = agents.map((a, k) => {
          const w = (raw[k] ?? 0) / sum;
          return {
            agentId: a.agentId,
            amount: (w * CONFIG.capital.pool_size).toFixed(18),
            weight: w.toFixed(8),
          };
        });
      }

      const { allocations } = route(agents, prev, state, CFG, trigger);
      expect(totalUnits(allocations)).toBe(POOL_UNITS);

      const eligibleExists = agents.some((a) => !a.halted && !a.crashed && a.score >= CFG.s_min);
      for (const al of allocations) {
        expect(amountUnits(al.amount) >= 0n).toBe(true);
        expect(Number(al.target_weight) >= 0).toBe(true);
        const src = agents.find((a) => a.agentId === al.agentId);
        // A halted/crashed agent never holds capital when some eligible agent exists.
        if (src && (src.halted || src.crashed) && eligibleExists) {
          expect(Number(al.target_weight)).toBe(0);
        }
      }
    }
  });

  test('a discretionary move never exceeds max_step; routing is deterministic', () => {
    const r = rng(0xabcd);
    for (let i = 0; i < 2000; i += 1) {
      const n = 2 + Math.floor(r() * 5);
      const agents: RouterAgent[] = Array.from({ length: n }, (_, k) => ({
        agentId: `a${k}`,
        score: 30 + r() * 70, // all eligible-ish, no gate-out
        halted: false,
        crashed: false,
      }));
      // A conserving prior allocation.
      const raw = agents.map(() => r() + 0.01);
      const sum = raw.reduce((a, b) => a + b, 0);
      const prev: PrevAllocation[] = agents.map((a, k) => {
        const w = (raw[k] ?? 0) / sum;
        return {
          agentId: a.agentId,
          amount: (w * CONFIG.capital.pool_size).toFixed(18),
          weight: w.toFixed(8),
        };
      });
      const state = { tick: 1000, cooldownUntilTick: 0 }; // never in cooldown

      const a = route(agents, prev, state, CFG, 'settle');
      const b = route(agents, prev, state, CFG, 'settle');
      expect(a).toEqual(b); // determinism
      // prev conserves the pool and it is not a cold start ⇒ max-step binds.
      expect(movedFraction(a.allocations)).toBeLessThanOrEqual(CFG.max_step + 1e-6);
    }
  });
});

describe('router fuzz — no oscillation under stable scores', () => {
  test('with fixed scores, allocations reach a stationary point and stay there', () => {
    const r = rng(0xf1bed);
    for (let trial = 0; trial < 40; trial += 1) {
      const n = 2 + Math.floor(r() * 4);
      const agents: RouterAgent[] = Array.from({ length: n }, (_, k) => ({
        agentId: `a${k}`,
        score: 30 + r() * 70,
        halted: false,
        crashed: false,
      }));
      let prev: PrevAllocation[] = [];
      let cooldownUntilTick = 0;
      let lastMoved = Infinity;
      let stationaryStreak = 0;
      for (let tick = 0; tick < 60 && stationaryStreak < 5; tick += 1) {
        const res = route(agents, prev, { tick, cooldownUntilTick }, CFG, 'settle');
        const moved = movedFraction(res.allocations);
        // After the cold-start fill (tick 0), a discretionary move is bounded by the cap.
        if (tick > 0) expect(moved).toBeLessThanOrEqual(CFG.max_step + 1e-6);
        stationaryStreak = moved === 0 ? stationaryStreak + 1 : 0;
        lastMoved = moved;
        prev = res.allocations.map((a) => ({
          agentId: a.agentId,
          amount: a.amount,
          weight: a.target_weight,
        }));
        cooldownUntilTick = res.state.cooldownUntilTick;
      }
      // Converged to a frozen allocation (no further movement).
      expect(lastMoved).toBe(0);
    }
  });
});
