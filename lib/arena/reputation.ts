import { compareDecimal } from '../intent/canonical';
import type { AgentSnapshot, ScoreChange } from './types';

/**
 * Reputation-drop derivation: turn two consecutive leaderboard polls into the
 * "leader's bar reddens, empties, and the agent falls in rank" collapse.
 *
 * The signal that distinguishes a routine score wobble from a *collapse* is
 * pinned to the seeded config, not guessed: a crash is the floor-crash the
 * scoring engine applies on a hard policy event (§6.1) — the score falling to at
 * or below `scoring.crash_cap` — or a status flip out of `active` into `gated`
 * or `halted`. Tying the threshold to `crash_cap` keeps the UI's notion of
 * "crash" identical to the backend's, so the animation fires exactly when the
 * reputation actually collapsed and never on ordinary churn.
 *
 * `deltaFraction` is a float over the 0–100 range for *bar geometry only*; the
 * exact prev/next scores are carried as strings for display and for the crash
 * comparison (which uses `compareDecimal`, never a float).
 */

const SCORE_RANGE = 100;

function toFraction(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n / SCORE_RANGE : 0;
}

function isCrashed(prev: AgentSnapshot, next: AgentSnapshot, crashCap: number): boolean {
  const flippedToGate = prev.status === 'active' && next.status !== 'active';
  // Score fell to at/below the floor-crash cap this poll (was above it before).
  const crossedFloor =
    compareDecimal(prev.score_current, crashCap) > 0 &&
    compareDecimal(next.score_current, crashCap) <= 0;
  return flippedToGate || crossedFloor;
}

/**
 * Per-agent score movement between two polls. Only agents present in *both*
 * snapshots are reported (a mount/unmount is not a "change"). `deltaFraction` is
 * `next - prev` over the score range; `isCrash` marks a reputation collapse per
 * {@link isCrashed}. Agents whose score and status are unchanged are still
 * included with `deltaFraction === 0` and `isCrash === false`, so callers can
 * treat the result as the full set of carried-over agents.
 *
 * @param crashCap the seeded `scoring.crash_cap` — the floor a hard policy event
 *   crashes a score to; crossing down to it (or a gate/halt) is a collapse.
 */
export function deriveScoreChanges(
  prev: readonly AgentSnapshot[],
  next: readonly AgentSnapshot[],
  crashCap: number,
): ScoreChange[] {
  const prevById = new Map(prev.map((a) => [a.id, a]));
  const changes: ScoreChange[] = [];
  for (const n of next) {
    const p = prevById.get(n.id);
    if (p === undefined) continue;
    changes.push({
      agentId: n.id,
      prevScore: p.score_current,
      nextScore: n.score_current,
      deltaFraction: toFraction(n.score_current) - toFraction(p.score_current),
      isCrash: isCrashed(p, n, crashCap),
    });
  }
  return changes;
}
