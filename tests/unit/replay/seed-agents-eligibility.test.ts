import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import {
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
