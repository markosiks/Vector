# Capital router (P1.3 — reputation-weighted allocation)

Source of truth: architecture.txt §6.2. This document pins the allocation rule,
the four anti-oscillation mechanisms, the forced gate-out, the round-0 bootstrap,
the **conservation invariant**, and the `capital_allocations` row contract.

The implementation is a pure function, `lib/router/route.ts#route`, plus a thin
persistence layer, `lib/router/record.ts`. `route()` performs no I/O, reads no
clock, and uses no randomness, so a fixed input yields a **bit-identical** result
on every run (the §6.5 determinism mandate). All amounts and weights are carried
end-to-end as fixed-scale decimal **strings** over BigInt arithmetic
(`lib/router/fixed-point.ts`) — never floats — so a row is exactly reproducible.

## What it does

Each round, the router moves a fixed capital pool (`CONFIG.capital.pool_size`,
denominated in `CONFIG.capital.capital_unit_label`) toward the agents with the
highest `AgentScore`, **visibly but stably**: reputation gains capital in bounded
steps, and a blocked theft (a crash/HALT) drains the offender's capital and
reroutes it to the honest leaders immediately. The pool is conserved exactly —
`Σ amount == pool_size` every round, with no rounding drift across thousands of
rounds.

## Inputs

`route(agents, prev, state, config, trigger)`:

| Arg       | Meaning                                                                                  |
| --------- | ---------------------------------------------------------------------------------------- |
| `agents`  | Per-agent `score` and gate-out flags (`halted`, `crashed`) for this round.                |
| `prev`    | The previous round's allocation rows (`amount`, `weight`); an absent agent ⇒ zero.        |
| `state`   | `{ tick, cooldownUntilTick }`. The tick is **caller-advanced**; `route` never moves it.   |
| `config`  | Seeded `router` constants + the conserved `pool_size` (`defaultRouterConfig()`).          |
| `trigger` | `settle` · `attestation` · `crash` · `operator` — persisted on every row.                 |

Callers should pass `agents` in a stable order (e.g. by `agentId`;
`deriveRouterAgents` sorts by id) so the apportionment tie-break is reproducible.
A non-finite score, or a non-positive/non-finite `τ`, throws `RangeError` — it is
never normalized into a silent allocation.

## Allocation rule (§6.2, steps 1–6, in order)

1. **Eligibility gate.** An agent is eligible iff `score ≥ s_min` and it is not
   `halted`/`crashed`. (Because the scoring floor-crash caps a crashed agent at
   `crash_cap = 7 < s_min = 30`, a crashed agent is never eligible anyway; the
   explicit flag makes the gate-out immediate and intent-revealing.)
2. **Target weights.** A temperature-softmax over the eligible set,
   `target_i ∝ exp(score_i / τ)`, computed max-stably. `τ → 0` degrades to
   winner-take-all (ties split evenly); `τ → ∞` to uniform.
3. **Hysteresis band.** If the largest per-agent weight move is `< h`, the
   configuration is "close enough" and the pass **freezes** — this is the
   debounce that stops capital twitching on score noise.
4. **Max-step.** A single global factor `λ = min(1, max_step / move)` caps the
   fraction of the pool relocated this pass (`move` = ½·Σ|target−prev|, the
   relocated fraction). Because `λ ≤ 1`, the update `next = prev + λ·(target−prev)`
   is **monotone** toward target and can never overshoot — the structural reason
   the allocation cannot oscillate.
5. **Cooldown.** After a clamped (large) move, discretionary rebalancing pauses
   for `cooldown_ticks`; only forced gate-outs and the cold-start fill move during
   a cooldown.
6. **Conservation.** The resulting weight vector is apportioned onto the integer
   pool by **largest-remainder (Hamilton)**: each agent gets `⌊w_i·pool⌋` units
   and the few leftover units go to the largest remainders (ties → lower index).
   This makes `Σ amount == pool` hold **by construction**, every round, with zero
   drift — the absolute target is apportioned afresh each round, never accumulated
   from deltas.

## Anti-oscillation — the four mechanisms

| Mechanism      | Constant         | Role                                                             |
| -------------- | ---------------- | --------------------------------------------------------------- |
| Hysteresis     | `h`              | Ignore sub-threshold target moves (debounce score noise).       |
| Max-step       | `max_step`       | Cap the per-round relocated fraction; guarantee monotone moves. |
| Cooldown       | `cooldown_ticks` | Pause discretionary churn after a large move.                   |
| Apportionment  | —                | Exact integer conservation, deterministic tie-break.            |

Together they make stable scores converge to a stationary allocation and then
**stop** — verified over long simulations in `tests/e2e` and `tests/fuzz`.

## Forced gate-out (crash / HALT) — bypasses hysteresis and cooldown

A `crash`/`operator` trigger, **or** any agent that is `halted`/`crashed` while
still holding capital, forces an immediate rebalance straight to the merit
target: the offender is gated to zero and its capital reroutes to the eligible
leaders this instant, regardless of the hysteresis/cooldown debounce. Max-step
does **not** rate-limit the freed capital, because an immediate gate-out and pool
conservation cannot both hold otherwise.

> **Design choice.** A forced pass snaps the *whole* allocation to the current
> softmax target (not just the offender's freed slice). This is deliberate: it is
> the demo's climax — a blocked theft collapses reputation and visibly drains the
> offender's capital to the honest agents in one round. The alternative
> (redistribute only the freed slice, smooth the rest) is stabler but mutes the
> signal; it can be reinstated by moving the gate-out into the discretionary
> branch if a future product decision favors it.

## Round-0 bootstrap

On a cold start (no prior allocation):

- **Nobody eligible** (seed priors `score_0 < s_min`): the pool is split **equally**
  across the live (non-gated) seed agents, so each gains capital-at-risk and
  scoring can start — otherwise the system deadlocks ("no allocation ⇒ no CaR ⇒
  score never rises").
- **Some eligible**: the first pass fills straight to the softmax target —
  max-step does not rate-limit a fill from an empty pool (there is no prior
  position to step from). The bootstrap pass starts a cooldown.

## No-eligible fallback

When no agent clears `s_min` mid-run, capital is **held with the live survivors**
(below `s_min` but not gated), in proportion to their current shares, else an even
split — it is never assigned to a halted/crashed agent. Only the degenerate state
where *every* agent is gated parks the pool evenly across all agents, purely to
stay conserved.

## `target_weight` semantics — realized, not ideal

`target_weight` is the **realized** post-move weight, `amount / pool_size`, so the
four stored columns are mutually consistent:

```
delta        = target_weight − prev_weight    (exact, at 8-dp)
target_weight × pool_size ≈ amount             (apportioned, ±1 unit)
```

The P1.6 animation reads `prev_weight` and `delta` to render the **actual**
capital flow — there is no second "ideal vs. realized" weight to drift apart. The
internal softmax "ideal" (where capital would settle at `λ = 1`) is not persisted;
it is recovered by re-running `route` with `max_step = 1`.

## `capital_allocations` row contract

`record.ts` writes one row per **material** allocation (an agent that holds
capital now, or that just had it drained). An agent that was and stays empty is
omitted as ledger noise; this does not affect conservation, since omitted rows
carry no capital.

| Column         | Type            | Meaning                                                       |
| -------------- | --------------- | ------------------------------------------------------------ |
| `amount`       | `numeric(38,18)`| Allocated capital this round, in `capital_unit_label`. `≥ 0`. |
| `target_weight`| `numeric(9,8)`  | Realized weight, `amount / pool_size`. `[0, 1]`.             |
| `prev_weight`  | `numeric(9,8)`  | The agent's weight before this pass. `[0, 1]`.               |
| `delta`        | `numeric(9,8)`  | `target_weight − prev_weight` (signed).                      |
| `trigger`      | `allocation_trigger` | What caused the re-route.                               |

## Determinism

`route` is pure and the arithmetic is integer/BigInt, so a fixed input is
bit-identical across runs (locked by `tests/unit/router.golden.test.ts` against
`tests/fixtures/router-golden.json` — the deterministic demo arc: bootstrap →
merit step → crash reroute). Conservation, non-negativity, the max-step bound,
eligibility, and no-oscillation-after-cooldown are property-fuzzed over thousands
of draws in `tests/fuzz` and stressed over thousands of rounds in `tests/e2e`.
