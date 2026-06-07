import {
  AMOUNT_SCALE,
  apportion,
  formatUnits,
  parseUnits,
  ratioToFixed,
  subtractFixed,
  toUnits,
  WEIGHT_SCALE,
} from './fixed-point';
import type {
  Allocation,
  PrevAllocation,
  RouteResult,
  RouterAgent,
  RouterConfig,
  RouterState,
  RouteTrigger,
} from './types';

/**
 * Pure, deterministic capital router — architecture.txt §6.2 (P1.3).
 *
 * {@link route} maps one round's scores and the previous allocation to a new
 * allocation that **always conserves the fixed pool** (`Σ amount == pool_size`,
 * exactly, every pass) while moving capital toward merit *visibly but stably*.
 * It performs no I/O, reads no clock, and uses no randomness, so a fixed input
 * (including the agent order) yields a bit-identical result on every run **on a
 * given runtime** (§6.5 determinism mandate). The one caveat: the softmax uses
 * `Math.exp`, whose last-ULP result is not guaranteed identical across JS
 * engines / CPUs, so cross-host replay should be pinned to one runtime. The
 * persistence layer lives in `record.ts`.
 *
 * ## Allocation rule (§6.2, steps 1–6, in order)
 *
 * 1. **Eligibility gate** — only `score ≥ s_min` and not `halted`/`crashed`.
 * 2. **Target weights** — temperature-softmax over the eligible set,
 *    `target_i ∝ exp(score_i / τ)`, numerically stable (max-subtraction).
 * 3. **Hysteresis band** — if the largest per-agent weight move is `< h`, the
 *    configuration is "close enough" and the pass freezes (debounce).
 * 4. **Max-step** — a single global factor `λ = min(1, max_step / move)` caps
 *    the fraction of the pool relocated this pass; because `λ ≤ 1`, the move is
 *    monotone toward target and can never overshoot (no oscillation).
 * 5. **Cooldown** — after a large move, discretionary rebalancing pauses for
 *    `cooldown_ticks`; only forced gate-outs (and the cold-start fill) move.
 * 6. **Conservation** — the resulting weight vector is apportioned onto the
 *    integer pool by largest-remainder, so the `amount`s sum to the pool exactly
 *    with no rounding drift across rounds ({@link apportion}).
 *
 * ## Forced gate-out (crash / HALT) — bypasses hysteresis and cooldown
 *
 * A `crash`/`operator` trigger, or any agent that is `halted`/`crashed` while
 * holding capital, forces an **immediate** rebalance straight to the merit
 * target: the offender is gated to zero and its capital reroutes to the eligible
 * leaders this instant, regardless of the hysteresis/cooldown debounce. This is
 * the demo's climax — a blocked theft collapses reputation and drains the
 * offender's capital to the honest agents. Max-step does **not** rate-limit the
 * freed capital, since an immediate gate-out and pool conservation cannot both
 * hold otherwise.
 *
 * ## Round-0 bootstrap
 *
 * On a cold start (no prior allocation) where no agent is yet eligible (priors
 * `score_0 < s_min`), the pool is split equally across the live seed agents so
 * each gains capital-at-risk and scoring can start — otherwise the system
 * deadlocks ("no allocation ⇒ no CaR ⇒ score never rises"). When a cold start
 * *does* have eligible agents, the first pass fills straight to the softmax
 * target (max-step does not rate-limit a fill from an empty pool).
 */

/** Per-agent working state accumulated through the routing pass. */
interface Node {
  readonly agent: RouterAgent;
  readonly prevAmt: bigint;
  readonly prevWeightUnits: bigint;
  prevW: number;
  eligible: boolean;
  gatedOut: boolean;
  target: number;
  next: number;
}

/** Reject a non-finite numeric input deterministically. */
function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`route(): ${label} must be finite, got ${value}`);
  }
}

/**
 * Parse a stored `amount`/`weight` from the previous allocation into integer
 * units, rejecting a negative value. The prior comes from the ledger and is a
 * non-negative quantity by the `capital_allocations` CHECK constraints; a
 * negative here means a corrupted row, so fail loudly rather than let it skew
 * `prevSum`/`prevW` (or force a false cold start) and corrupt the move policy.
 */
function parsePrevUnits(value: string, scale: number, label: string): bigint {
  const units = parseUnits(value, scale);
  if (units < 0n) {
    throw new RangeError(`route(): ${label} must be >= 0, got ${value}`);
  }
  return units;
}

/** A finite float ratio `num / den` (den > 0), computed with extended precision. */
function ratioFloat(num: bigint, den: bigint): number {
  const PREC = 1_000_000_000_000_000n; // 1e15: well within Number's 2^53 mantissa.
  return Number((num * PREC) / den) / 1e15;
}

/**
 * Numerically stable temperature-softmax over `scores`, returning weights that
 * sum to 1. Subtracting the max keeps `exp` arguments `≤ 0`, so `τ → 0` degrades
 * to winner-take-all (ties split evenly) and `τ → ∞` to uniform, both without
 * overflow.
 */
function softmax(scores: readonly number[], tau: number): number[] {
  if (!Number.isFinite(tau) || tau <= 0) {
    throw new RangeError(`route(): tau must be finite and > 0, got ${tau}`);
  }
  const max = scores.reduce((m, s) => (s > m ? s : m), -Infinity);
  const exps = scores.map((s) => Math.exp((s - max) / tau));
  const sum = exps.reduce((acc, e) => acc + e, 0); // ≥ 1 (the max term is exp(0)=1)
  return exps.map((e) => e / sum);
}

/**
 * The target weight vector (sums to 1) before anti-oscillation: softmax over the
 * eligible set, or — when no agent is eligible — capital held with the live
 * (non-gated) survivors, falling back to an even split. Weight is never assigned
 * to a gated-out (halted/crashed) agent unless *every* agent is gated, a
 * documented degenerate state where the pool is parked evenly to stay conserved.
 */
function targetWeights(nodes: readonly Node[], tau: number): number[] {
  const eligible = nodes.flatMap((nd, i) => (nd.eligible ? [{ i, score: nd.agent.score }] : []));

  if (eligible.length > 0) {
    const weights = softmax(
      eligible.map((e) => e.score),
      tau,
    );
    const byIndex = new Map<number, number>();
    eligible.forEach((e, k) => byIndex.set(e.i, weights[k] ?? 0));
    return nodes.map((_, i) => byIndex.get(i) ?? 0);
  }

  const survivors = nodes.flatMap((nd, i) => (nd.gatedOut ? [] : [{ i, prevW: nd.prevW }]));
  if (survivors.length > 0) {
    const mass = survivors.reduce((acc, s) => acc + s.prevW, 0);
    const byIndex = new Map<number, number>();
    survivors.forEach((s) => byIndex.set(s.i, mass > 0 ? s.prevW / mass : 1 / survivors.length));
    return nodes.map((_, i) => byIndex.get(i) ?? 0);
  }

  // Degenerate: every agent is gated out. Park the pool evenly to stay conserved.
  return nodes.map(() => 1 / nodes.length);
}

/**
 * Route capital for one pass (§6.2). Returns the per-agent {@link Allocation}s
 * (their `amount`s summing exactly to `config.pool_size`) and the updated
 * {@link RouterState} carrying the next cooldown deadline.
 *
 * @param agents  This round's per-agent scores and gate-out flags. Callers
 *                should pass a stable order (e.g. by `agentId`) for reproducible
 *                tie-breaks; an invalid score throws {@link RangeError}.
 * @param prev    The previous round's allocation rows (absent agent ⇒ zero).
 * @param state   Current tick and cooldown deadline (caller-advanced tick).
 * @param config  Seeded `router` + `capital` constants.
 * @param trigger The re-route trigger, persisted on every row.
 */
export function route(
  agents: readonly RouterAgent[],
  prev: readonly PrevAllocation[],
  state: RouterState,
  config: RouterConfig,
  trigger: RouteTrigger,
): RouteResult {
  if (agents.length === 0) {
    return { allocations: [], state };
  }

  const { s_min, tau, h, max_step, cooldown_ticks, pool_size } = config;
  const pool = toUnits(pool_size, AMOUNT_SCALE);

  const prevByAgent = new Map<string, PrevAllocation>();
  for (const p of prev) prevByAgent.set(p.agentId, p);

  // 0 — Build per-agent nodes; validate scores; gate eligibility / forced gate-out.
  const nodes: Node[] = agents.map((agent) => {
    requireFinite(agent.score, `score(${agent.agentId})`);
    const p = prevByAgent.get(agent.agentId);
    const prevAmt =
      p === undefined
        ? 0n
        : parsePrevUnits(p.amount, AMOUNT_SCALE, `prev amount(${agent.agentId})`);
    const prevWeightUnits =
      p === undefined
        ? 0n
        : parsePrevUnits(p.weight, WEIGHT_SCALE, `prev weight(${agent.agentId})`);
    const gatedOut = agent.halted || agent.crashed;
    return {
      agent,
      prevAmt,
      prevWeightUnits,
      prevW: 0,
      eligible: !gatedOut && agent.score >= s_min,
      gatedOut,
      target: 0,
      next: 0,
    };
  });

  // Previous weights, renormalized over the *present* agents so they sum to 1
  // (a vanished agent's capital is reabsorbed pro-rata). A zero sum marks a cold
  // start: there is no prior position to rate-limit a move from.
  const prevSum = nodes.reduce((acc, nd) => acc + nd.prevAmt, 0n);
  const coldStart = prevSum === 0n;
  for (const nd of nodes) nd.prevW = coldStart ? 0 : ratioFloat(nd.prevAmt, prevSum);

  // A held-capital agent that is now gated out must be drained this pass.
  const forcedByGate = nodes.some((nd) => nd.gatedOut && nd.prevAmt > 0n);

  // 2 — Target weights, then write them onto the nodes.
  const target = targetWeights(nodes, tau);
  nodes.forEach((nd, i) => {
    nd.target = target[i] ?? 0;
  });

  // 3–5 — Anti-oscillation. `forced` (crash/operator/gate-out) and the cold-start
  // fill bypass the hysteresis/cooldown/max-step debounce and snap to target.
  const forced = trigger === 'crash' || trigger === 'operator' || forcedByGate;
  const inCooldown = state.tick < state.cooldownUntilTick;

  let largeMove: boolean;
  if (coldStart || forced) {
    for (const nd of nodes) nd.next = nd.target;
    largeMove = true;
  } else {
    const maxDev = nodes.reduce((m, nd) => Math.max(m, Math.abs(nd.target - nd.prevW)), 0);
    const totalMove = 0.5 * nodes.reduce((acc, nd) => acc + Math.abs(nd.target - nd.prevW), 0); // relocated fraction

    if (maxDev < h || inCooldown) {
      for (const nd of nodes) nd.next = nd.prevW; // hysteresis freeze or cooldown defer
      largeMove = false;
    } else {
      const lambda = totalMove <= max_step ? 1 : max_step / totalMove;
      for (const nd of nodes) nd.next = nd.prevW + lambda * (nd.target - nd.prevW);
      largeMove = lambda < 1; // clamped by max-step ⇒ mid-transition ⇒ start a cooldown
    }
  }

  // 6 — Conservation: apportion the absolute weight vector onto the integer pool.
  const amounts = apportion(
    nodes.map((nd) => nd.next),
    pool,
  );

  const allocations: Allocation[] = nodes.map((nd, i) => {
    const amountUnits = amounts[i] ?? 0n;
    const targetWeight = ratioToFixed(amountUnits, pool, WEIGHT_SCALE);
    const prevWeight = formatUnits(nd.prevWeightUnits, WEIGHT_SCALE);
    return {
      agentId: nd.agent.agentId,
      amount: formatUnits(amountUnits, AMOUNT_SCALE),
      target_weight: targetWeight,
      prev_weight: prevWeight,
      delta: subtractFixed(targetWeight, prevWeight, WEIGHT_SCALE),
      trigger,
    };
  });

  const nextState: RouterState = {
    tick: state.tick,
    cooldownUntilTick: largeMove ? state.tick + cooldown_ticks : state.cooldownUntilTick,
  };

  return { allocations, state: nextState };
}
