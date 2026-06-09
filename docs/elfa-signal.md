# Elfa social-sentiment signal (P3.1 / §9.3)

A **read-only** social-sentiment hint surfaced to a seed agent's decision
context. The signal reads one Elfa endpoint — trending-tokens aggregation
(per-token social sentiment / mentions / mindshare) — caches it behind a slow
poller, and injects the current snapshot into the **runner-up's**
`context.signals.elfa`. It exists to give the runner-up's `decide` a
*sentiment-aware* flavor in the demo narrative; it never touches what executes.

It is the second seed-agent flavor signal, deliberately distinct from the Nansen
smart-money signal (P2.2): Nansen targets the **leader** (`seed-leader`), Elfa
targets the **runner-up** (`seed-2`). The two never collide.

Code: [`lib/signals/elfa/`](../lib/signals/elfa) and the injection helper
[`lib/replay/signals.ts`](../lib/replay/signals.ts). Tests:
`tests/unit/signals.elfa.*.test.ts`, `tests/unit/replay/elfa-inject.test.ts`,
`tests/fuzz/signals.elfa.fuzz.test.ts`,
`tests/integration/signals.elfa.integration.test.ts`,
`tests/e2e/signals.elfa.e2e.test.ts`.

Config lives only in `CONFIG.elfa` (see [config.md](./config.md)); the key is
`ELFA_API_KEY` (see [env.md](./env.md)).

## The distinctive invariant: a value is *always* present

Unlike Nansen — whose `current()` returns `undefined` until the first successful
fetch and whose loader returns `null` without a key — the Elfa signal is
**always available**. `provider.current()` returns the last successful **live**
snapshot when one exists, otherwise a **deterministic seeded mock**. It is never
`undefined`, so `context.signals.elfa` is always populated.

Every snapshot is transparently source-marked with `origin: 'live' | 'mock'`, so
a consumer (or an audit) can always tell a real reading from the seeded stand-in.

This is what the §4.2 Definition of Done requires: a real-or-mock value is always
present, a missing key never breaks the tick, the mode is configurable, and the
"wow path" stays independent of Elfa.

## Three load-bearing invariants

### 1. The tick never blocks on the network

The agent hot path only ever calls a **synchronous, total** read; any fetch runs
on its own slow cadence, detached:

- `provider.current()` returns the current snapshot (live, else the seeded mock).
  It never throws, never does I/O, and never returns `undefined`.
- `provider.maybeRefresh(tickIndex)` is **fire-and-forget**. `runArc` calls it
  once per tick and never `await`s it. In **live** mode it may *start* a
  background fetch; in **mock** mode it is a no-op. It returns immediately.

Refresh (live mode only) is **doubly gated** to spend credits sparingly: a fetch
starts only when the slow cadence is due (`poll_every_n_ticks`) **and** the cache
is stale (`cache_ttl_ms`). A single in-flight request is **deduped**, so a burst
of ticks never fans out into parallel calls. An optional `maxCalls` budget
hard-stops new fetches once exhausted (then `current()` keeps serving the last
snapshot / mock).

### 2. Read-only into `context`, never into execution — fail-open

The snapshot is placed in `context.signals.elfa` and is visible to `decide`
only. Because a seed agent's `decide` returns an Intent that **never embeds
`signals`**, the value is structurally unable to reach signing, the referee, or
the rail. Any client failure (timeout, `429`, `402`, `5xx`, malformed JSON) is
**swallowed** inside the provider; the last good value (live snapshot, else the
mock) stays in place, so a broken, unpaid, or absent Elfa never stalls or
perturbs the arc.

This is proven, not asserted by convention:
[`tests/e2e/signals.elfa.e2e.test.ts`](../tests/e2e/signals.elfa.e2e.test.ts)
signs the **entire arc twice** — once with the runner-up's Elfa signal injected,
once empty — and requires the signed Intent bytes to be **byte-identical** (for
both a mock and a wall-clock live snapshot).

### 3. Mode is a single config flag; the default keeps the arc byte-identical

A **live** snapshot carries a wall-clock `fetchedAtMs` and is therefore
**non-deterministic**, so live mode is **opt-in**. The seeded **mock** uses a
fixed `fetchedAtMs` (no clock, no randomness) and is **byte-stable**.

The mode is resolved once at load time from `CONFIG.elfa.mode` + key presence:

- **live** — `CONFIG.elfa.mode === 'real'` **and** `ELFA_API_KEY` is set. The
  provider polls the live endpoint and falls back to the mock on any failure.
  Enabling live mode makes the arc non-deterministic *by design* — an explicit
  opt-in.
- **mock** — every other case (`mode === 'mock'`, or `real` with no key). The
  provider is mock-only: it never touches the network and serves the
  deterministic seeded snapshot. Because the mock is byte-stable and the seed
  strategies **ignore `context.signals`**, wiring it keeps the arc/score
  byte-identical to a no-signal run.

`provider.mode()` reports the resolved mode for observability. The integration
test runs `runArc` with a live, *flapping* provider (and, separately, a mock-only
provider) and asserts the end-state (crashed agents, final allocations) equals
the baseline run.

## Modes: real, x402, and mock

Elfa exposes a single read endpoint, reachable in three ways; all three converge
on the same normalized `ElfaSignal`:

- **real (API key)** — the live client sends the key in the `x-elfa-api-key`
  header. This is what `mode: 'real'` + `ELFA_API_KEY` selects.
- **x402 (pay-per-call)** — when no key / credit is available, Elfa answers
  `402 Payment Required` (USDC-on-Base settlement). The client models this
  distinctly as `ElfaPaymentRequiredError` so observability can separate
  "payment/credit" from "server fault"; both still degrade fail-open. The full
  x402 settle-and-retry handshake is **not** implemented in the MVP (see Risks).
- **mock** — the deterministic seeded snapshot, used whenever live is not
  selected or as the fail-open fallback.

## Trust boundary & secrets

- `ELFA_API_KEY` is read in exactly one place,
  [`lib/signals/elfa/load.ts`](../lib/signals/elfa/load.ts) (`server-only`), and
  flows only into the client's `x-elfa-api-key` request header — never into a
  response DTO, an agent's `context`, a log line, or an `executions` payload.
- Untrusted input = the HTTP response. It is parsed defensively (zod, tolerant of
  key aliases and envelope shapes incl. nested `{ data: { items: [...] } }`),
  bounded (response body ≤ 2 MiB, rows ≤ 50, raw rows scanned ≤ 5000), and any
  value that is not a finite number is dropped. A response that cannot be
  confidently normalized becomes a typed `ElfaParseError` — never partial or
  guessed data.
- Usage/credit observability is emitted via `ElfaLogger` events (`fetch_start` /
  `fetch_success` / `fetch_error` / `budget_exhausted`) that carry only counts
  and a static endpoint label — never secrets or response bodies. The logger is
  treated as fallible: every emit is wrapped, so a sink that throws can never
  reject the detached fetch or throw into the tick.
- Because the key rides in a request header, the endpoint is **`https`-only**
  (enforced by the config schema) and the client uses `redirect: 'error'` — it
  refuses to follow a redirect that could replay the credential to another
  origin. The wall-clock timeout spans the whole round-trip (connect **and**
  body read), so a slow-drip body cannot hang the fetch; the row scan is capped
  independently of output, so a hostile all-empty array cannot stall the loop.
- The host is **never hardcoded** in the client: it is injected from
  `CONFIG.elfa.endpoint`, keeping `api.elfa.ai` a single source of truth in
  `constants.ts` (enforced by `tests/e2e/single-source.e2e.test.ts`). Only the
  endpoint **path** is a local constant.

## Wiring (opt-in)

```ts
import { loadElfaSignalProvider } from '@/lib/signals/elfa/load';
import { runArc } from '@/lib/replay';

// Always returns a provider: live when CONFIG.elfa.mode === 'real' AND the key
// is set, otherwise a deterministic mock-only provider.
const elfa = loadElfaSignalProvider({ maxCalls: 100, logger });
await runArc(db, arc, { elfa });
```

Because `loadElfaSignalProvider` never returns `null`, wiring it always populates
the runner-up's `context.signals.elfa`. In mock mode (the keyless default) the
provider never touches the network and the value is byte-stable, so a keyless
deployment stays on the byte-identical path.
