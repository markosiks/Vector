# ADR 0001 — Single seeded config + SWR polling (no sockets)

- **Status:** Accepted
- **Stage:** P0.1
- **References:** architecture.txt §6.1 (Determinism note), §7.3, §11, §13

## Context

Vector's value proposition is a **deterministic** 90-second demo: merit → blocked
theft → reputation collapse → capital reroute, identical on every run given the
same seed and attack timing. Two foundational decisions shape everything built
on top.

## Decision 1 — One seeded, typed, immutable config

All scoring/routing/timing/signal/policy/capital/chain constants live in a single
module (`lib/config/constants.ts`), validated by a zod schema at load and deeply
frozen.

**Why:**

- **Determinism & explainability.** Judges can read the entire numeric basis of
  the system on one screen. A run is reproducible because there is exactly one
  place values come from.
- **Safety.** Range validation at startup turns silent corruption (a negative
  penalty, `alpha` out of range, a `NaN` tick rate) into a loud, immediate
  failure. Deep-freeze turns accidental mutation into a thrown error.
- **Refactor leverage.** Re-tuning the demo arc is a one-file change that
  provably propagates to every consumer (enforced by the single-source e2e test).

**Alternatives rejected:** scattering constants at call sites (non-reproducible,
unauditable); a database-backed config (adds I/O and non-determinism to the hot
path for values that are fixed for the demo); env-based numeric tuning (env is
for secrets/wiring, not algorithm constants, and lacks type safety).

## Decision 2 — SWR interval polling, not WebSockets

Live screens read our HTTP API through SWR at a single fixed interval
(`ui_poll_ms`); there are no sockets in the core path.

**Why:**

- **Reliability under demo pressure.** A fixed-interval poll has no connection
  lifecycle to manage on stage; the replay engine's tick rate is tuned so the
  arc lands on cue regardless of client timing.
- **Simplicity.** One cadence drives every screen; the value is sourced from the
  seeded config, so retuning the pace is the same one-file change.

**Alternatives rejected:** hand-rolled WebSockets (fragile reconnection,
backpressure, and ordering concerns for no benefit at this cadence); fetching in
`useEffect` (race conditions, no dedup/revalidation story).

## Consequences

- Constants are non-secret and isomorphic; secrets stay in server-only env.
- The polling cadence and all algorithm constants are tunable in one file each.
- Sockets remain out of the core path; if real-time pushes are ever needed, they
  enrich rather than gate the demo.
