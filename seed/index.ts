import { CONFIG } from '@/lib/config/constants';
import type { SchedulerTiming } from '@/lib/replay/scheduler';
import { roundCount } from '@/lib/replay/scheduler';
import { SEED_AGENTS, SEED_LEADER_ID } from '@/lib/agents/seed';
import type { MarketQuote } from '@/lib/intent/types';

/**
 * The frozen, versioned demo dataset (architecture.txt §6.5).
 *
 * This is the seed the whole arc replays from: a fixed virtual start time, a
 * per-tick market script, a per-(agent, tick) deterministic rail fill, and the
 * canned attack timing. Everything is produced by {@link buildDemoArc} from a
 * handful of frozen parameters and closed-form integer formulas — **no clock and
 * no randomness** — so the same `(version, params, timing)` always yields a
 * byte-identical arc (the golden test pins it).
 *
 * The arc *length* is `rounds * ticks_per_round`: changing `CONFIG.timing` scales
 * the demo predictably (the §7 config-sensitivity property) without touching the
 * dataset's shape. All money quantities are canonical decimal **strings** built
 * from integers, never floats, matching the "numeric is exact" invariant.
 *
 * The seeded fill is the rail's *result*, deliberately decoupled from the agent's
 * realized PnL math (there is no live venue in the spine): the leader earns more
 * on higher capital-at-risk and climbs; the runner-up earns steadily and stays
 * eligible; at {@link AttackSpec.atTick} the leader's decision is replaced by the
 * drain, which the real referee blocks — so that tick produces no fill.
 *
 * The attack lands on the **settle tick of the penultimate round**, so the drain
 * is scored (crashing the leader) at a settle that still has a *following* round
 * to route into — that next round's allocation is where the freed capital visibly
 * flows to the runner-up. A single-round arc has no such follow-on round, so the
 * attack falls back to its only settle tick (the block still fires; the reroute
 * is simply not observable until a later round exists).
 */

/** Schema version of the seed dataset; bump on any shape/value change. */
export const SEED_VERSION = '1.0.0';

/** Fixed virtual epoch the arc's clock starts from (2026-01-01T00:00:00Z). */
export const SEED_BASE_TIME_MS = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

/** How long after its tick an Intent's `ttl` stays valid (one full round). */
export const SEED_TTL_HORIZON_MS = CONFIG.timing.tick_rate_ms * CONFIG.timing.ticks_per_round;

/** Default number of rounds in the demo arc (`9 * 5 ticks * 2s = 90s`). */
export const DEMO_ROUNDS = 9;

/** Canonical fresh-wallet destination of the canned drain (never whitelisted). */
export const ATTACKER_ADDRESS = `0x${'ba'.repeat(20)}`;

/** A per-(agent, tick) deterministic rail fill — the outcome of a seeded execution. */
export interface SeedOutcome {
  readonly pnl_realized: string;
  readonly pnl_marked: string;
  readonly capital_at_risk: string;
  readonly fees: string;
  readonly position_delta: string;
  readonly drawdown: string;
}

/** The market snapshot for one tick (the `context.markets` fed to `decide`). */
export interface SeedTick {
  readonly index: number;
  readonly markets: Readonly<Record<string, MarketQuote>>;
}

/** The canned attack: which agent drains, to where, at which tick. */
export interface AttackSpec {
  /** Global tick index at which the target's decision becomes the drain. */
  readonly atTick: number;
  /** Stable `agent_id` of the agent whose Intent is replaced by the drain. */
  readonly targetAgentId: string;
  /** Fresh-wallet destination of the drain `transfer` (rejected by rule #3). */
  readonly attackerAddress: string;
}

/** The fully-materialized, frozen demo arc. */
export interface DemoArc {
  readonly version: string;
  /** Virtual epoch the arc's clock starts from. */
  readonly baseTimeMs: number;
  /** `ttl = tickInstant + ttlHorizonMs` for every stamped Intent. */
  readonly ttlHorizonMs: number;
  /** Total tick count (`rounds * ticks_per_round`). */
  readonly totalTicks: number;
  /** Stable agent ids in roster order. */
  readonly agentIds: readonly string[];
  /** Per-tick market script (length `totalTicks`). */
  readonly ticks: readonly SeedTick[];
  /** Per-agent, per-tick rail fills: `outcomes[agentId][tickIndex]`. */
  readonly outcomes: Readonly<Record<string, readonly SeedOutcome[]>>;
  /** The canned attack timing/target. */
  readonly attack: AttackSpec;
}

/** Options for {@link buildDemoArc}. */
export interface BuildDemoArcOptions {
  /** Round count (default {@link DEMO_ROUNDS}). The arc has `rounds * ticks_per_round` ticks. */
  readonly rounds?: number;
  /** Timing slice (default `CONFIG.timing`). */
  readonly timing?: SchedulerTiming;
}

/** Deterministic BTC-PERP price for a tick: a fixed upward drift, exact integer. */
function btcPriceAt(index: number): string {
  return String(60_000 + index * 50);
}

/**
 * The deterministic rail fill for an agent at a tick. The leader (higher
 * `carBase`) earns more on more capital-at-risk and so climbs above the
 * runner-up; both stay clean (no policy violations come from the fill itself).
 */
function seedOutcomeAt(carBase: number, pnlBase: number, index: number): SeedOutcome {
  return {
    pnl_realized: String(pnlBase + index * (pnlBase >> 2)),
    pnl_marked: '0',
    capital_at_risk: String(carBase),
    fees: String((carBase >> 10) + 1),
    position_delta: '1',
    // A small, steady intra-round drawdown well under dd_tol (0.15); 3 dp.
    drawdown: '0.020',
  };
}

/**
 * Per-agent fill profile, keyed by stable agent id.
 *
 * `carBase` (capital-at-risk per tick) and `pnlBase` (PnL per tick) are the two
 * knobs that place an agent on the leaderboard. The two ineligible personalities
 * (`seed-3`/`seed-4`) are tuned so their EWMA AgentScore stays strictly below the
 * router's `s_min` (30) for the entire arc — by *different* mechanisms, which is
 * what makes them distinguishable while keeping the leader→runner-up drain
 * reroute byte-identical (an ineligible agent never receives pool capital):
 *
 *  - `seed-3` (featherweight): profitable (`perf → 1`) but a tiny `carBase`, so
 *    the anti-Sybil weight `w_r = car/(car+c_floor)` caps its score near 25.
 *  - `seed-4` (contrarian): a loss (`pnlBase < 0`), so `perf → 0` and the score
 *    decays toward the floor.
 *
 * The eligibility invariant is asserted in
 * `tests/unit/replay/seed-agents-eligibility.test.ts`; changing these constants
 * without re-checking it can silently break the drain demo.
 */
const FILL_PROFILE: Readonly<Record<string, { carBase: number; pnlBase: number }>> = {
  // Leader: most capital-at-risk *and* the best return on it, so it leads on
  // both axes the score rewards (return-on-CaR and the anti-Sybil capital weight).
  'seed-leader': { carBase: 32_000, pnlBase: 1_200 },
  'seed-2': { carBase: 6_000, pnlBase: 120 },
  // Featherweight: real profit on negligible capital ⇒ high perf, low weight.
  'seed-3': { carBase: 50, pnlBase: 20 },
  // Contrarian: a steady loss ⇒ perf collapses, score decays to the floor.
  'seed-4': { carBase: 1_500, pnlBase: -200 },
};

/**
 * Drain-safety invariant, enforced at module load: every roster agent must have
 * an **explicit** fill profile.
 *
 * The roster (`SEED_AGENTS`) and `FILL_PROFILE` are two append-only lists that
 * must stay in sync. A missing entry is a programming error — and a dangerous
 * one: it would otherwise fall back to a generic, *router-eligible* default
 * (`w = car/(car+c_floor) = 0.5`, `perf → 1` ⇒ score ≈ 50 > `s_min`), silently
 * adding an unintended capital-bearing agent and splitting the leader→runner-up
 * drain reroute. We fail loudly here so the mistake surfaces the moment the
 * module is imported (in any test or at startup) rather than as a corrupted arc.
 */
for (const agent of SEED_AGENTS) {
  if (!Object.prototype.hasOwnProperty.call(FILL_PROFILE, agent.id)) {
    throw new Error(
      `seed: SEED_AGENTS member "${agent.id}" has no FILL_PROFILE entry; ` +
        'every roster agent must declare an explicit fill profile (drain-safety invariant).',
    );
  }
}

/**
 * Build the frozen demo arc. Pure and deterministic: a fixed seed
 * `(version, rounds, timing)` always yields the same arc. The attack lands on
 * the **settle tick of the final round** so the drain's `policy_event` is scored
 * in that round, crashing the leader exactly as capital settles — the climax.
 */
export function buildDemoArc(options: BuildDemoArcOptions = {}): DemoArc {
  const timing = options.timing ?? CONFIG.timing;
  const rounds = options.rounds ?? DEMO_ROUNDS;
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new RangeError(`buildDemoArc: rounds must be a positive integer, got ${rounds}`);
  }
  const totalTicks = rounds * timing.ticks_per_round;

  const ticks: SeedTick[] = [];
  for (let index = 0; index < totalTicks; index += 1) {
    ticks.push({
      index,
      markets: {
        'BTC-PERP': {
          price: btcPriceAt(index),
          ts: new Date(SEED_BASE_TIME_MS + index * timing.tick_rate_ms).toISOString(),
        },
      },
    });
  }

  const outcomes: Record<string, SeedOutcome[]> = {};
  for (const agent of SEED_AGENTS) {
    // Totality is guaranteed by the module-load invariant above; this throw
    // keeps the lookup type-total (no silent, router-eligible default profile).
    const profile = FILL_PROFILE[agent.id];
    if (profile === undefined) {
      throw new Error(`seed: no FILL_PROFILE entry for roster agent "${agent.id}"`);
    }
    outcomes[agent.id] = Array.from({ length: totalTicks }, (_, index) =>
      seedOutcomeAt(profile.carBase, profile.pnlBase, index),
    );
  }

  return {
    version: SEED_VERSION,
    baseTimeMs: SEED_BASE_TIME_MS,
    ttlHorizonMs: timing.tick_rate_ms * timing.ticks_per_round,
    totalTicks,
    agentIds: SEED_AGENTS.map((a) => a.id),
    ticks,
    outcomes,
    attack: {
      // Settle tick of the penultimate round (so a follow-on round exists to
      // route the freed capital into); clamps to the only settle tick of a
      // single-round arc.
      atTick: Math.max(timing.ticks_per_round - 1, totalTicks - timing.ticks_per_round - 1),
      targetAgentId: SEED_LEADER_ID,
      attackerAddress: ATTACKER_ADDRESS,
    },
  };
}

/** The default, frozen demo arc (9 rounds, `CONFIG.timing`). */
export const DEMO_ARC: DemoArc = buildDemoArc();

/** Round count of an arc, derived from its tick count and the timing grid. */
export function arcRounds(arc: DemoArc, timing: SchedulerTiming = CONFIG.timing): number {
  return roundCount(arc.totalTicks, timing);
}
