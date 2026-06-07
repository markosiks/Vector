import { compareDecimal } from '../intent/canonical';
import { clamp01 } from './easing';
import type { AgentView } from './types';
import type { LeaderboardEntryDto } from '../api/dto';

/**
 * Deterministic ranking for the Arena board.
 *
 * The read API already returns agents ordered `score_current DESC, created_at
 * ASC`, but the screen re-establishes that order itself for two reasons: it must
 * not assume the transport preserved it, and — critically — the tie-break has to
 * be **identical every poll** or equal-score agents would swap places and the
 * board would shimmer. The comparator orders by exact score (never a float),
 * then `created_at ASC`, then `id ASC` as a final total-order guarantee, so the
 * same inputs always yield the same ranks and React keys stay put.
 */

const SCORE_RANGE = 100;

/** Total order: score DESC, then created_at ASC, then id ASC. */
function compareEntries(a: LeaderboardEntryDto, b: LeaderboardEntryDto): number {
  const byScore = compareDecimal(b.score_current, a.score_current);
  if (byScore !== 0) return byScore;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** Safe float for *geometry only*; non-finite or malformed input maps to `0`. */
function toFraction(value: string | null, range: number): number {
  if (value === null) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return clamp01(n / range);
}

/**
 * Rank a leaderboard page into stable {@link AgentView}s. The input is copied
 * before sorting (the DTO array is treated as immutable) and the resulting order
 * is deterministic for equal scores, so consecutive polls produce the same ranks
 * and the same keys — no flicker on re-sort. `allocationFraction` is computed
 * against `poolSize` for bar geometry; a `0`/non-finite pool yields `0` rather
 * than dividing by zero.
 */
export function rankAgents(entries: readonly LeaderboardEntryDto[], poolSize: number): AgentView[] {
  const pool = Number.isFinite(poolSize) && poolSize > 0 ? poolSize : 0;
  return [...entries].sort(compareEntries).map((e, rank) => ({
    id: e.id,
    displayName: e.display_name,
    owner: e.owner,
    strategyKind: e.strategy_kind,
    status: e.status,
    rank,
    score: e.score_current,
    scoreFraction: toFraction(e.score_current, SCORE_RANGE),
    allocation: e.allocation,
    allocationFraction: pool === 0 ? 0 : toFraction(e.allocation, pool),
  }));
}

/** A single agent's rank movement between two polls (`delta < 0` = climbed). */
export interface RankChange {
  readonly agentId: string;
  readonly from: number;
  readonly to: number;
  /** `to - from`: negative means the agent moved up the board, positive down. */
  readonly delta: number;
}

/**
 * Rank movements between two ranked boards, keyed by agent id. Agents present in
 * both polls and whose rank actually changed are returned; a newly-appearing or
 * departing agent has no "from"/"to" pair and is omitted (the row mounts/unmounts
 * rather than animating a move).
 */
export function detectRankChanges(
  prev: readonly AgentView[],
  next: readonly AgentView[],
): RankChange[] {
  const prevRank = new Map(prev.map((a) => [a.id, a.rank]));
  const changes: RankChange[] = [];
  for (const a of next) {
    const from = prevRank.get(a.id);
    if (from !== undefined && from !== a.rank) {
      changes.push({ agentId: a.id, from, to: a.rank, delta: a.rank - from });
    }
  }
  return changes;
}
