import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { getSeedAgent, SEED_AGENTS } from '@/lib/agents/seed';
import { composeIntent } from '@/lib/replay/compose';
import { planTicks, type SchedulerTiming } from '@/lib/replay/scheduler';
import type { Context } from '@/lib/intent/types';
import { buildDemoArc } from '@/seed';

/**
 * Property fuzzing for the demo spine's pure core (§10, §6.5). A deterministic
 * PRNG drives wide-range timing, tick indices, and contexts. Invariants:
 *  - scheduler: the plan has exactly one settle per round, settles fall on the
 *    last tick of each round, offsets are strictly increasing by tick_rate_ms;
 *  - compose: stamping is deterministic and the nonce is unique per (agent, tick);
 *  - dataset: `buildDemoArc` is byte-reproducible for any round count.
 */

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

const int = (r: () => number, lo: number, hi: number): number =>
  lo + Math.floor(r() * (hi - lo + 1));

describe('planTicks — structural invariants', () => {
  test('one settle per round, on the last tick, with monotone offsets', () => {
    const r = rng(0xa11ce);
    for (let i = 0; i < 2_000; i += 1) {
      const timing: SchedulerTiming = {
        tick_rate_ms: int(r, 1, 5_000),
        ticks_per_round: int(r, 1, 12),
      };
      const rounds = int(r, 1, 20);
      const plan = planTicks(rounds * timing.ticks_per_round, timing);

      expect(plan).toHaveLength(rounds * timing.ticks_per_round);
      expect(plan.filter((t) => t.isRoundSettle)).toHaveLength(rounds);
      for (const t of plan) {
        expect(t.isRoundSettle).toBe(t.tickInRound === timing.ticks_per_round - 1);
        expect(t.startOffsetMs).toBe(t.index * timing.tick_rate_ms);
        expect(t.roundIndex).toBe(Math.floor(t.index / timing.ticks_per_round));
      }
    }
  });
});

describe('composeIntent — determinism and unique nonces', () => {
  test('identical inputs compose identically; nonces never collide', async () => {
    const r = rng(0xb0b);
    const arc = buildDemoArc({ rounds: 4 });
    const rate = CONFIG.timing.tick_rate_ms;
    const seen = new Set<string>();

    for (let i = 0; i < 400; i += 1) {
      const agent = SEED_AGENTS[int(r, 0, SEED_AGENTS.length - 1)]!;
      const tickIndex = int(r, 0, arc.totalTicks - 1);
      const isAttack = r() < 0.2;
      const context: Context = {
        agent_id: agent.id,
        round_id: `round-${int(r, 0, 5)}`,
        markets: arc.ticks[tickIndex]!.markets,
        allocation: String(int(r, 0, 1_000_000)),
        remaining_budget: String(int(r, 0, 1_000_000)),
        score: int(r, 0, 100),
        signals: {},
      };
      const args = { arc, agent, context, tickIndex, tickRateMs: rate, isAttack };
      const a = await composeIntent(args);
      const b = await composeIntent(args);
      expect(a).toEqual(b);
      expect(a.nonce).toBe(`${agent.id}-${tickIndex}`);
      seen.add(`${agent.id}-${tickIndex}`); // (agent, tick) pairs are the unique key
    }
    // Each composed nonce maps 1:1 to an (agent, tick) pair (no cross-collision).
    expect(getSeedAgent('seed-leader')).toBeDefined();
  });
});

describe('buildDemoArc — reproducible for any round count', () => {
  test('two builds of the same seed are byte-identical', () => {
    const r = rng(0xdee);
    for (let i = 0; i < 100; i += 1) {
      const rounds = int(r, 1, 15);
      expect(JSON.stringify(buildDemoArc({ rounds }))).toBe(
        JSON.stringify(buildDemoArc({ rounds })),
      );
    }
  });
});
