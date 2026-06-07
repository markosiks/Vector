# Arena / Leaderboard Screen (P1.6)

The heroic demo surface at **`/arena`**: a ranked board of agents that, over a
~90-second arc, shows capital flowing to the leader, a competitor's reputation
collapsing, and a referee **policy block flashing red** the moment it happens.

It is a thin rendering shell over pure logic. All behaviour — ranking,
capital-flow, reputation-drop, red-flash, formatting, easing — lives in
[`lib/arena/`](../lib/arena) as total functions over plain data, unit-, fuzz-,
and browser-tested independently of React.

## Data sources — read-only, no backend changes

The screen consumes only the **P1.5 read API** (see [`read-api.md`](./read-api.md)).
No endpoints were added or changed for P1.6.

| Channel | Endpoint | Used for |
| --- | --- | --- |
| Leaderboard | `GET /api/leaderboard` | ranks, scores, allocations, round state |
| Policy feed | `GET /api/policy-events?limit=50` | the red-alert channel (REJECT/HALT) |

Both poll on the **single app-wide cadence** `CONFIG.timing.ui_poll_ms`,
configured once in [`app/providers.tsx`](../app/providers.tsx). No hook overrides
it, so retuning the cadence in one place retunes the whole screen.

### Why SWR-polling, not WebSockets

The product is deliberately socket-free: every live surface is an SWR poll over
`no-store` read endpoints. Polling keeps the backend stateless and horizontally
scalable, survives reconnects without a session protocol, and means the demo has
exactly one freshness knob. The cost — animations can't be driven by server
push — is paid on the client (below). For a projector demo this is the right
trade: simpler, more robust, and good enough at a 1.5 s cadence.

## How the animations are derived

The read API reports **state**, not events: the leaderboard exposes each agent's
current `allocation` and `score_current`, not the router's deltas. So every
animation is reconstructed **client-side by diffing the current poll against the
previous one** ([`usePrevious`](../app/arena/hooks.ts)).

- **Capital flow.** [`deriveFlows`](../lib/arena/flow.ts) computes each agent's
  signed allocation change as a fraction of `CONFIG.capital.pool_size`;
  [`pairFlows`](../lib/arena/flow.ts) greedily matches outflows to inflows into a
  few arcs (leader → runner-up). Bar widths animate to the new allocation; the
  transition duration is scaled by move size vs `CONFIG.router.max_step` via
  [`flowDurationMs`](../lib/arena/easing.ts).
- **Reputation drop.** [`deriveScoreChanges`](../lib/arena/reputation.ts) diffs
  `score_current`. A **crash** is a score crossing *down to* `CONFIG.scoring.crash_cap`
  (7) **or** a status flip out of `active` (gated/halted). Crashed rows redden and
  empty their bars and fall in rank.
- **Rank slides (FLIP).** [`rankAgents`](../lib/arena/rank.ts) sorts by score
  DESC, then `created_at` ASC, then id ASC (stable — input order never changes the
  result). When the order changes, [`useFlip`](../app/arena/useFlip.ts) animates
  the slide so an agent visibly climbs or falls.
- **Red flash.** [`selectFlashes`](../lib/arena/flash.ts) picks new `REJECT`/`HALT`
  events from the feed, **de-duplicated by event id** across polls *and within a
  single (possibly noisy) page*, so each block flashes exactly once. A burst in
  one poll collapses to a single screen-level flash with a count
  ([`summarizeFlashes`](../lib/arena/flash.ts)). A block is visible **within one
  poll interval** of being written — that one-interval window is the precise
  meaning of "the moment of the block" under polling.

### Precision invariant

Display and comparison use **exact decimal strings** (`compareDecimal` /
`normalizeDecimal` from [`lib/intent/canonical.ts`](../lib/intent/canonical.ts));
floats are used **only** for visual geometry (bar widths, easing curves) and are
kept in separate fields. A score or capital figure is always an exact prefix of
the stored `numeric` — `formatCapital`/`formatScore` truncate, never round, so
the screen never implies capital or reputation that isn't there.

## Behaviour & accessibility

- **Reduced motion.** [`useReducedMotion`](../app/arena/hooks.ts) and the
  `prefers-reduced-motion` media query disable slides, bar transitions, and the
  strobe; the red-flash degrades to a static red vignette + edge so the *signal*
  survives without the motion.
- **Errors.** A feed error shows a non-blocking banner and keeps the last board —
  it never tears the screen down. A transient `undefined` between revalidations is
  ignored, so the animation baseline is never wiped mid-arc.
- **Empty / loading.** Distinct "loading" and "no agents yet" states.
- **Bounded memory.** The red-flash `seen` set is pruned to the current feed page
  each poll, so a long-running screen does not grow it without bound. This is safe
  because the feed is append-only / newest-first (an event never resurrects).

## Files

```
lib/arena/        pure logic (types, format, easing, rank, flow, reputation, flash)
app/arena/        page.tsx · Arena.tsx (orchestrator) · Leaderboard · AgentRow ·
                  RedFlash · hooks.ts · useFlip.ts · arena.module.css
```

## Tests

| Suite | Command | Notes |
| --- | --- | --- |
| Unit | `bun run test:unit` | `tests/unit/arena.*` — pure logic, ~96% line coverage |
| Fuzz | `bun run test:fuzz` | `tests/fuzz/arena.fuzz.test.ts` — random data + jittery polling; invariants: total order, finite/bounded flows, at-most-once flash over a monotonic feed |
| Browser e2e | `bun run test:e2e:browser` | `tests/browser/arena.spec.ts` (Playwright) — drives the full arc with the API scripted at the network layer (`page.route`), so it needs only a Next dev server, no database |
| Live e2e | `DATABASE_URL=… bun run test:e2e:live` | `tests/browser/arena.live.spec.ts`, orchestrated by `scripts/e2e/arena-live.ts` — **no mocks.** Drives the real demo-spine pipeline against a real Postgres while the browser polls the real API |

The Playwright suite lives in `tests/browser/` (its own runner), **separate from**
`tests/e2e/` which is the bun-test API suite (`bun run test:e2e`). First run:
`bunx playwright install chromium`.

### Live e2e

`test:e2e:live` proves the screen against the **real pipeline + real Postgres** —
nothing is mocked. `scripts/e2e/arena-live.ts` owns the moving parts the spec must
not know about:

- It runs inside a **throwaway schema** wired into every connection via the URL's
  `options=-c search_path=<schema>,public`, so the run never touches `public` and
  the schema is dropped on exit (even on failure). Point `DATABASE_URL` at any
  Postgres (e.g. Neon).
- It seeds the cold-start board, starts `next dev` against that schema, then drives
  a **paced** `runArc(...)` whose round settles are slowed so the browser's poll
  cadence observes each transition.
- The cold-start board is a transient, so the arc is **gated** behind a one-shot
  control endpoint: the spec asserts the opening board, then hits
  `ARENA_CONTROL_URL/start` to release it. This makes the opening state
  deterministic rather than racing the pipeline against Playwright cold-start /
  lazy route compilation. Everything the arc unfolds afterwards (the persisted
  red-flash, the settled crash) survives the poll cadence, so the rest of the
  assertions lean on Playwright's retrying `expect`.

The exit code is the Playwright result, so it is CI-usable. First run:
`bunx playwright install chromium`.
