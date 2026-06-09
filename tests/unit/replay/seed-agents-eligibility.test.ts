import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import {
  SEED_AGENTS,
  SEED_CONTRARIAN_ID,
  SEED_FEATHERWEIGHT_ID,
  SEED_LEADER_ID,
  SEED_RUNNER_UP_ID,
} from '@/lib/agents/seed';
import type { OutcomeRow, PolicyEventRow } from '@/lib/db/schema';
import { deriveScoreInputs, score } from '@/lib/scoring';
import { buildDemoArc, type SeedOutcome } from '@/seed';

/**
 * Regression guard for the demo-spine drain invariant (P3.2 §4.2).
 *
 * The two extra personalities (`seed-3` featherweight, `seed-4` contrarian) are
 * deliberately engineered to stay **ineligible for capital** — their EWMA
 * AgentScore must remain strictly below the router's `s_min` for the entire arc.
 * That is what guarantees they can never receive pool capital and so can never
 * perturb the leader→runner-up reroute when the drain crashes the leader: an
 * ineligible agent is gated out of `targetWeights`, so the freed capital flows
 * 100% to the runner-up exactly as it did before these agents existed.
 *
 * It also pins the *contrast* that makes them distinguishable: the leader and
 * runner-up cross `s_min` (eligible, capital-bearing), the two new agents never
 * do, and they get there by different mechanisms (profit-but-tiny-weight vs.
 * loss), so a single threshold separates "earns capital" from "shown but denied".
 *
 * This is a pure replay of the scorer over the frozen seed outcomes — no DB, no
 * clock — so a parameter drift in `FILL_PROFILE` that accidentally lifts a new
 * agent over `s_min` (silently breaking the drain demo) fails here.
 */

const TPR = CONFIG.timing.ticks_per_round;
const S_MIN = CONFIG.router.s_min;

/** A minimal {@link OutcomeRow} carrying only the fields the scorer reads. */
function outcomeRow(o: SeedOutcome): OutcomeRow {
  return {
    pnl_realized: o.pnl_realized,
    pnl_marked: o.pnl_marked,
    capital_at_risk: o.capital_at_risk,
    drawdown: o.drawdown,
  } as unknown as OutcomeRow;
}

/**
 * Replay every round's clean AgentScore for one agent over the arc's seeded
 * fills, threading the EWMA prior. No policy events: the two new agents trade
 * cleanly (their fills are decoupled losses/gains, not violations), so the only
 * scripted policy event in the arc — the leader's drain — never touches them.
 */
function scoreTrajectory(agentId: string): number[] {
  const arc = buildDemoArc();
  const fills = arc.outcomes[agentId];
  if (fills === undefined) throw new Error(`no fills for ${agentId}`);
  const rounds = arc.totalTicks / TPR;
  const noEvents: PolicyEventRow[] = [];

  let prev = CONFIG.scoring.score_0;
  const trajectory: number[] = [];
  for (let r = 0; r < rounds; r += 1) {
    const roundFills = fills.slice(r * TPR, r * TPR + TPR).map(outcomeRow);
    const inputs = deriveScoreInputs(roundFills, noEvents);
    const result = score(inputs, prev, CONFIG.scoring);
    const scoreR = Number(result.score_r);
    trajectory.push(scoreR);
    prev = scoreR;
  }
  return trajectory;
}

describe('extra seed agents — eligibility invariant (drain-safety)', () => {
  test('seed-3 and seed-4 stay strictly below s_min for every round', () => {
    for (const id of [SEED_FEATHERWEIGHT_ID, SEED_CONTRARIAN_ID]) {
      const traj = scoreTrajectory(id);
      const max = Math.max(...traj);
      expect(max).toBeLessThan(S_MIN);
      // A real margin, not a knife-edge: a small constant nudge must not flip it.
      expect(max).toBeLessThanOrEqual(S_MIN - 2);
    }
  });

  test('the leader and runner-up DO cross s_min (capital-bearing, by contrast)', () => {
    for (const id of [SEED_LEADER_ID, SEED_RUNNER_UP_ID]) {
      const traj = scoreTrajectory(id);
      expect(Math.max(...traj)).toBeGreaterThanOrEqual(S_MIN);
    }
  });

  test('the two new personalities are distinguishable: profit vs. loss', () => {
    // Featherweight is profitable (perf high) yet capped by its tiny weight; the
    // contrarian loses, so its score decays well below the featherweight's.
    const feather = scoreTrajectory(SEED_FEATHERWEIGHT_ID);
    const contrarian = scoreTrajectory(SEED_CONTRARIAN_ID);
    const lastFeather = feather[feather.length - 1]!;
    const lastContrarian = contrarian[contrarian.length - 1]!;
    expect(lastFeather).toBeGreaterThan(lastContrarian);
  });

  test('the replay is deterministic (same arc ⇒ identical trajectory)', () => {
    expect(scoreTrajectory(SEED_FEATHERWEIGHT_ID)).toEqual(scoreTrajectory(SEED_FEATHERWEIGHT_ID));
  });
});

describe('fill-profile totality (drain-safety: no silent eligible default)', () => {
  // The eligibility invariant above only holds if EVERY roster agent draws its
  // own explicit, distinct fill profile. A missing entry used to fall back to a
  // generic `{ carBase: 1000, pnlBase: 10 }`, which is router-*eligible*
  // (w = 1000/(1000+c_floor) = 0.5, perf → 1 ⇒ score ≈ 50 > s_min) and would
  // silently add an unintended capital-bearing agent to the drain reroute. The
  // fallback is gone; these guard that no agent slips through on a default.

  test('every roster agent is given fills (no agent is silently dropped)', () => {
    const arc = buildDemoArc();
    for (const agent of SEED_AGENTS) {
      const fills = arc.outcomes[agent.id];
      expect(fills).toBeDefined();
      expect(fills!.length).toBe(arc.totalTicks);
    }
    // Outcomes cover exactly the roster — no stray / missing keys.
    expect(new Set(Object.keys(arc.outcomes))).toEqual(new Set(SEED_AGENTS.map((a) => a.id)));
  });

  test('each agent uses its own distinct seeded capital_at_risk, not a default', () => {
    const arc = buildDemoArc();
    const carOf = (id: string): number => Number(arc.outcomes[id]![0]!.capital_at_risk);
    // The four documented, distinct profiles (seed/index.ts FILL_PROFILE).
    expect(carOf(SEED_LEADER_ID)).toBe(32_000);
    expect(carOf(SEED_RUNNER_UP_ID)).toBe(6_000);
    expect(carOf(SEED_FEATHERWEIGHT_ID)).toBe(50);
    expect(carOf(SEED_CONTRARIAN_ID)).toBe(1_500);
    // All four are distinct — a fallback would collapse two of them onto 1000.
    const cars = SEED_AGENTS.map((a) => carOf(a.id));
    expect(new Set(cars).size).toBe(cars.length);
  });
});
