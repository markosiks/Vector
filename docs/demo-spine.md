# Demo spine (P1.4)

The **demo spine** is the deterministic backbone that runs the hackathon demo. It
drives a frozen, scripted "arc" through the **real** pipeline — the same referee,
scoring, and capital router used in production — so the demo is honest (no mocked
verdicts) and reproducible (same seed ⇒ byte-identical run).

```
signal → decide → intent → referee → execution → outcome
                                                     │
                                              score (P1.2)
                                                     │
                                      [attestation seam (P1.8)]   ← score BEFORE route
                                                     │
                                       capital re-route (P1.3)
```

Code lives in `lib/replay/` (the orchestrator and its pure helpers), `lib/agents/seed/`
(the scripted roster) and `seed/index.ts` (the frozen dataset). Entry point:
`runArc(db, DEMO_ARC)`.

## What it demonstrates

A ~90-second arc (9 rounds × `ticks_per_round` ticks at `tick_rate_ms`) with two
seed agents:

- **`seed-leader`** — most capital-at-risk *and* the best return on it, so it leads
  on both axes the score rewards and holds the majority of the capital pool.
- **`seed-2`** — a smaller, steady runner-up.

On the **penultimate round's settle tick** an operator injects a fund-draining
`transfer` to a fresh wallet from the leader. The pipeline reacts on its own:

1. the **referee** blocks it — `REJECT` / `hard`, rule #3 `fresh_wallet_transfer_block`
   (the only fund-moving action, and the load-bearing security property);
2. **scoring** sees the hard policy event (`drain_r`) and **crashes** the leader's
   score to `crash_cap` (7);
3. the crash gates the leader out, so the **router** re-routes its capital to
   `seed-2` for the final round — visibly, with the pool conserved to the last unit.

A `fallback` keeps the show running: if the execution rail returns nothing or
throws, the tick settles on the deterministic seeded fill (`degraded` flagged),
never stalling the arc.

## Determinism contract

The arc is a pure function of its seed `(version, rounds, timing)`. Guarantees:

- **One clock.** Every Intent is stamped and validated against the arc's *virtual*
  clock — `tickInstant(tick) = baseTimeMs + index · tick_rate_ms` — never
  `Date.now()`. Pacing (sleeping between ticks for the live demo) is the caller's
  concern and never feeds back into the logic.
- **No randomness.** Strategies and the dataset are deterministic; signatures are
  RFC-6979 deterministic ECDSA, so re-signing the same payload is byte-identical.
- **Stable identity.** Each Intent's nonce is `${agentId}-${tickIndex}` — unique
  per `(agent, tick)`, so a re-run reserves no new nonces (idempotent).
- **Result:** the same `(arc, config)` yields an identical sequence of decisions,
  signed Intents, hashes, and persisted rows.

The contract is pinned by tests:

| Test | Pins |
| --- | --- |
| `tests/unit/replay.arc.golden.test.ts` | a `rounds=2` arc, bit-for-bit, vs `tests/fixtures/seed-arc-golden.json` |
| `tests/e2e/replay.e2e.test.ts` | full signed-arc determinism + the referee blocking the drain (rule #3) |
| `tests/fuzz/replay.fuzz.test.ts` | scheduler invariants, compose determinism, dataset reproducibility |
| `tests/integration/replay.integration.test.ts` | end-to-end on real Neon: conserved pool, leader crash, reroute, idempotency |

Regenerate the golden fixture **intentionally** (and review the diff) only when the
dataset `version` changes.

## Seams

- **Attestation (P1.8).** `runArc`'s `onScored` hook fires after each agent is
  scored and **before** capital re-routes — the exact point an on-chain score
  anchor belongs. In the spine it is a no-op observability hook.
- **Execution rail.** `RunArcOptions.rail` injects a real rail; the default is the
  deterministic seed rail backed by the arc's fills. `settleWithFallback` degrades
  to the seeded fill on any rail miss.
- **Operator attack.** Beyond the scripted injection, `armAttack()` latches a
  one-shot drain that fires on the target's next tick — for a live "press the
  button" moment.

## Concurrency

Each round's settle (score every agent + route the next round) is one logical
write wrapped in a single `BEGIN…COMMIT`, so a partial settle can never persist a
non-conserving round. `runArc` therefore requires a **single-connection** client
(a pool *client*), not the shared pool.

## Migration

`0004_execution_rail_seed` adds a `seed` value to the `execution_rail` enum so the
spine's executions are tagged `rail = 'seed'` (distinct from live `byreal` fills).
The down migration rebuilds the enum without `seed` and fails loudly if any row
still uses it.
