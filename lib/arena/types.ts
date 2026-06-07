import type { AgentStatus, PolicyDecision, StrategyKind } from '../db/schema';
import type { LeaderboardEntryDto, PolicyEventDto, RoundDto } from '../api/dto';

/**
 * View-model types for the Arena / Leaderboard screen (P1.6).
 *
 * The split this module enforces is the screen's load-bearing invariant:
 *
 *  - **Exact decimal strings** (`score`, `allocation`) are carried verbatim from
 *    the read API for *display and comparison* — never routed through a float,
 *    so a `numeric(38,18)` allocation or a precise score is shown intact.
 *  - **Floats** (`scoreFraction`, `allocationFraction`, `deltaFraction`) exist
 *    only for *visual geometry* — bar widths, easing magnitudes, flow arcs —
 *    where a sub-pixel rounding error is invisible and float is the right tool.
 *
 * Keeping those two worlds in separate fields (and never deriving a displayed
 * value from a float) is what lets the demo be both precise and animated.
 */

/** One agent as the Arena renders it: exact strings for display, floats for geometry. */
export interface AgentView {
  /** Stable identity — the React key and the join key across polls. */
  readonly id: string;
  readonly displayName: string;
  readonly owner: string;
  readonly strategyKind: StrategyKind;
  readonly status: AgentStatus;
  /** Zero-based rank after the deterministic sort (0 = leader). */
  readonly rank: number;
  /** Exact AgentScore as returned (0–100), for display. */
  readonly score: string;
  /** Score as a `[0, 1]` fraction of the 0–100 range, for bar geometry only. */
  readonly scoreFraction: number;
  /** Exact capital allocation in the current round, or `null` if unfunded. */
  readonly allocation: string | null;
  /** Allocation as a `[0, 1]` fraction of the pool, for bar geometry only. */
  readonly allocationFraction: number;
}

/** The ranked board for one poll: round status, capital label, and ordered agents. */
export interface ArenaView {
  readonly round: RoundDto | null;
  readonly capitalUnit: string;
  readonly agents: readonly AgentView[];
}

/** Direction of an agent's capital change between two polls. */
export type FlowDirection = 'in' | 'out' | 'none';

/** A single agent's capital change between consecutive polls (geometry only). */
export interface CapitalFlow {
  readonly agentId: string;
  readonly direction: FlowDirection;
  /** Signed change as a fraction of the pool (`+` = gained, `−` = lost). */
  readonly deltaFraction: number;
}

/** A paired transfer arc: capital that left `fromAgentId` and arrived at `toAgentId`. */
export interface FlowArc {
  readonly fromAgentId: string;
  readonly toAgentId: string;
  /** Magnitude of the paired transfer as a fraction of the pool (always `> 0`). */
  readonly fraction: number;
}

/** An agent's score movement between consecutive polls. */
export interface ScoreChange {
  readonly agentId: string;
  readonly prevScore: string;
  readonly nextScore: string;
  /** Signed change as a `[-1, 1]` fraction of the 0–100 range (geometry only). */
  readonly deltaFraction: number;
  /**
   * `true` when this is a reputation *collapse* — the leader's bar should redden
   * and empty and the agent should fall in rank. A crash is either a score that
   * fell to at or below the floor-crash cap, or a status flip to `gated`/`halted`.
   */
  readonly isCrash: boolean;
}

/** A red-flash trigger derived from one REJECT/HALT policy event. */
export interface FlashTrigger {
  readonly eventId: string;
  readonly agentId: string;
  readonly decision: Extract<PolicyDecision, 'REJECT' | 'HALT'>;
  readonly createdAt: string;
}

/** The de-duplicated red-flash state produced from one poll of the feed. */
export interface FlashSelection {
  /** Newly-seen REJECT/HALT events in this poll (a burst collapses to a set). */
  readonly flashes: readonly FlashTrigger[];
  /** Event ids now seen — pass back next poll so a flash never re-fires. */
  readonly seen: ReadonlySet<string>;
}

/** Minimal projection of a leaderboard entry the derivations need. */
export type AgentSnapshot = Pick<
  LeaderboardEntryDto,
  'id' | 'status' | 'score_current' | 'allocation'
>;

/** Re-export for consumers that build derivations straight off feed pages. */
export type { PolicyEventDto };
