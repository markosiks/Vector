import type { AllocationTrigger } from '@/lib/db/schema';

/**
 * Capital-router types — architecture.txt §6.2 (P1.3).
 *
 * The router is a pure, deterministic function from this round's scores and the
 * previous allocation to a new allocation that **always conserves the fixed
 * pool**: capital is redistributed toward merit, never minted or burned. The
 * visible-but-stable reroute ("capital flows to #2") is produced by four
 * anti-oscillation mechanisms layered on a temperature-softmax target:
 * eligibility gate, hysteresis band, max-step rate limit, and a post-move
 * cooldown — plus an immediate gate-out for a crash/HALT that bypasses the
 * hysteresis/cooldown debounce.
 */

/** The re-route trigger ({@link AllocationTrigger}), persisted on every row. */
export type RouteTrigger = AllocationTrigger;

/**
 * Per-agent input to {@link route} for one routing pass.
 *
 * `score` is the agent's current AgentScore (`∈ [0, 100]` in practice, but the
 * router is robust to any finite value). `halted`/`crashed` are the explicit
 * gate-out signals (operator HALT / kill-switch, and a scoring floor-crash):
 * either one removes the agent immediately, bypassing hysteresis and cooldown,
 * which is what makes a blocked theft visibly drain the offender's capital.
 *
 * Anti-Sybil/anti-wash invariant: eligibility and target weight depend on
 * `score` alone — never on trade count, volume, or wallet age.
 */
export interface RouterAgent {
  /** Stable agent identifier (e.g. `agents.id`). Drives deterministic tie-breaks. */
  readonly agentId: string;
  /** Current AgentScore. Must be finite. */
  readonly score: number;
  /** Operator HALT / global kill-switch: gate out immediately (bypasses hysteresis). */
  readonly halted: boolean;
  /** Scoring floor-crash (confirmed drain / `#halt > 0`): gate out immediately. */
  readonly crashed: boolean;
}

/**
 * The agent's allocation as of the *previous* round, the baseline the move is
 * measured against. `amount` is the exact capital in pool units (the `numeric`
 * decimal string from `capital_allocations.amount`); `weight` is its fixed-scale
 * weight (`amount / pool_size`, the stored `target_weight`). An agent with no
 * prior allocation is simply absent from the `prev` list (treated as zero).
 */
export interface PrevAllocation {
  readonly agentId: string;
  /** Previous capital amount, exact decimal string in pool units. */
  readonly amount: string;
  /** Previous weight, fixed-scale decimal string in `[0, 1]`. */
  readonly weight: string;
}

/**
 * Router cooldown bookkeeping threaded between passes (§6.2 mechanism 4).
 *
 * `tick` is the current replay tick (caller-advanced; the router never reads a
 * clock). `cooldownUntilTick` is the first tick at which a *discretionary*
 * rebalance is allowed again after a large move; while `tick < cooldownUntilTick`
 * only forced gate-outs (crash/HALT) and bootstrap may move capital. {@link route}
 * returns the updated state for the caller to persist and pass back next time.
 */
export interface RouterState {
  /** Current replay tick (monotonic, caller-advanced). */
  readonly tick: number;
  /** First tick a discretionary move is permitted again; `0` means no cooldown. */
  readonly cooldownUntilTick: number;
}

/**
 * The router config slice — `CONFIG.router` merged with `CONFIG.capital`. The
 * caller passes the seeded config so the function stays pure and testable.
 */
export interface RouterConfig {
  /** Minimum score to be eligible for capital (`s_min`). */
  readonly s_min: number;
  /** Softmax temperature (`tau`); lower concentrates capital on the leader. */
  readonly tau: number;
  /** Hysteresis band (`h`): ignore a rebalance whose largest weight move is `< h`. */
  readonly h: number;
  /** Max-step rate limit (`max_step`): max fraction of the pool moved per pass. */
  readonly max_step: number;
  /** Cooldown in ticks after a large reallocation (`cooldown_ticks`). */
  readonly cooldown_ticks: number;
  /** Fixed pool size, conserved across every reallocation (`pool_size`). */
  readonly pool_size: number;
}

/**
 * One agent's new allocation. `amount` and the three weight fields are canonical
 * fixed-scale decimal *strings* (quantized to their `numeric` column scale) so
 * the persisted row is bit-for-bit reproducible and carries no float drift.
 *
 * - `amount`        — realized capital in pool units (`numeric(38,18)`). The
 *                     `amount`s across one pass sum **exactly** to `pool_size`.
 * - `target_weight` — realized weight this round (`amount / pool_size`, 8 dp).
 * - `prev_weight`   — the agent's weight last round (8 dp).
 * - `delta`         — `target_weight − prev_weight` (8 dp), the signed move for
 *                     the P1.6 animation.
 */
export interface Allocation {
  readonly agentId: string;
  readonly amount: string;
  readonly target_weight: string;
  readonly prev_weight: string;
  readonly delta: string;
  readonly trigger: RouteTrigger;
}

/**
 * Result of {@link route}: the per-agent {@link Allocation}s (summing to the pool)
 * and the threaded {@link RouterState} (updated `cooldownUntilTick`).
 */
export interface RouteResult {
  readonly allocations: readonly Allocation[];
  readonly state: RouterState;
}
