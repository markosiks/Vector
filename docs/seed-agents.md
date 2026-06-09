# Seed agents (P3.2)

The demo spine drives a frozen roster of **seed agents** through the *real*
pipeline (referee → scoring → router). This doc is the canonical reference for
who is on the roster, what each one demonstrates, and the invariants that keep
the arc deterministic and the drain scenario intact.

Roster lives in [`lib/agents/seed/index.ts`](../lib/agents/seed/index.ts); the
frozen per-agent fills (`carBase`/`pnlBase`) live in
[`seed/index.ts`](../seed/index.ts) under `FILL_PROFILE`.

## The roster

| id | personality | market / side | `carBase` | `pnlBase` | score arc | eligible? |
| --- | --- | --- | --- | --- | --- | --- |
| `seed-leader` | **leader** — most capital-at-risk *and* best return | BTC-PERP long | 32 000 | +1 200 | climbs to ~99, then **crashes to 7** on the drain | yes → loses it on crash |
| `seed-2` | **runner-up** — smaller, steady | BTC-PERP long | 6 000 | +120 | climbs to ~99 | yes → **inherits** the pool |
| `seed-3` | **featherweight** — profitable, negligible capital | BTC-PERP long | 50 | +20 | plateaus ~25 | **no** (below `s_min`) |
| `seed-4` | **contrarian** — loss-making fade | ETH-PERP short | 1 500 | −200 | decays to ~5 | **no** (below `s_min`) |

`seed-3` and `seed-4` are the P3.2 additions. They are distinguishable on the
leaderboard (different markets, sides, sizes, and clearly different score
trajectories) yet are *engineered to never receive capital* — see below.

## Why score is independent of allocation

An agent's AgentScore is computed from its **seeded `capital_at_risk`**
(`carBase`, fixed in `FILL_PROFILE`), not from the capital the router allocates
to it (§6.1–§6.2). Adding agents therefore **cannot change an existing agent's
score** — it only changes how the shared pool is *allocated*. This is what makes
it safe to extend the roster without touching the leader/runner-up arc.

## Eligibility invariant (drain-safety)

The router only routes to agents whose score is **≥ `s_min` (30)** and that are
not gated/crashed (`lib/router/route.ts`). The two new personalities are tuned so
their EWMA score stays **strictly below `s_min` for the entire arc**, by two
*different* mechanisms — which is exactly what makes them readable as distinct:

- **`seed-3` (featherweight)** is genuinely profitable (`perf → 1`) but trades a
  tiny `carBase`, so the anti-Sybil capital weight `w_r = car/(car + c_floor)`
  caps `100·perf·w` near 20 and the score plateaus ~25. It is the live proof that
  merit is weighted on capital exposure, not raw return — a high-return, low-stake
  agent never qualifies for the pool.
- **`seed-4` (contrarian)** runs a steady loss (`pnlBase < 0`), so `perf → 0` and
  its score decays toward the `crash_cap` floor. It is the live proof that the
  merit layer withholds capital from an underperformer.

Because neither new agent is ever eligible, the leader→runner-up reroute is
**byte-identical** to the two-agent arc: when the drain crashes the leader, the
freed capital flows 100% to `seed-2` (the only other eligible agent), pool
conserved to the last unit. This is asserted, without a DB, in
[`tests/unit/replay/seed-agents-eligibility.test.ts`](../tests/unit/replay/seed-agents-eligibility.test.ts).

> **Changing `FILL_PROFILE`?** Re-run the eligibility guard. Any drift that lifts
> a new agent over `s_min` silently breaks the drain demo by splitting the
> reroute. The guard requires a ≥ 2-point margin, not a knife-edge.

## Determinism

The roster is append-only and order-stable: **append** new agents, never reorder
or renumber existing ones (deterministic tie-breaks and the golden arc depend on
the order). Each agent has a fixed, distinct throwaway signing key, so signatures
are byte-identical on re-run (RFC-6979 deterministic ECDSA). The `rounds=2` arc is
pinned in [`tests/fixtures/seed-arc-golden.json`](../tests/fixtures/seed-arc-golden.json);
regenerate it **intentionally** (and review the diff) only when the dataset
changes.

## Score breakdown (P2.3 → P3.2)

The agent-detail screen reconstructs §6.1 —
`raw = clamp(100·perf·w + policy − dd, 0, 100)` — as plain data in
[`lib/credibility/components.ts`](../lib/credibility/components.ts). P3.2 adds a
**proportional bar** layer (`buildBreakdown().contributions` and `resultFillPct`)
that renders the three additive point-terms (`performance × weight`, `policy`,
`−dd`) and the net result on a shared 0–100 axis:

- each contribution carries `points` (signed), `sign`
  (`positive`/`negative`/`zero`), and `widthPct = clamp(|points|/100, 0, 1)·100`,
  so the render sizes a bar directly and an extreme term (stacked `hard`s,
  oversized drawdown) **saturates** the bar instead of overflowing it;
- `resultFillPct = clamp(raw/100, 0, 1)·100` is the net bar;
- the geometry is pure and unit-tested
  ([`tests/unit/credibility/components.test.ts`](../tests/unit/credibility/components.test.ts));
  the React layer ([`ScoreBreakdown.tsx`](../app/agents/[id]/ScoreBreakdown.tsx))
  is a thin map. The bars honour `prefers-reduced-motion` and truncate long
  labels rather than reflowing the grid.
