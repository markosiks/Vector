# Nansen smart-money signal (P2.2 / §7.6)

A **read-only** smart-money hint surfaced to a seed agent's decision context. The
signal reads one Nansen Smart Money endpoint — `netflows` (net USD flow by
smart-money wallets per token) — caches it behind a slow poller, and injects the
cached snapshot into the leader's `context.signals.nansen`. It exists to make the
leader's `decide` *smart-money-aware* in the demo narrative; it never touches what
executes.

Code: [`lib/signals/nansen/`](../lib/signals/nansen) and the injection helper
[`lib/replay/signals.ts`](../lib/replay/signals.ts). Tests:
`tests/unit/signals.nansen.*.test.ts`, `tests/unit/replay.nansen-inject.test.ts`,
`tests/fuzz/signals.nansen.fuzz.test.ts`,
`tests/integration/signals.nansen.integration.test.ts`,
`tests/e2e/signals.nansen.e2e.test.ts`.

Config lives only in `CONFIG.nansen` (see [config.md](./config.md)); the key is
`NANSEN_API_KEY` (see [env.md](./env.md)).

## Two load-bearing invariants

### 1. The tick never blocks on the network

The agent hot path only ever calls a **synchronous, total** read; the fetch runs
on its own slow cadence, detached:

- `provider.current()` returns the last successful snapshot (or `undefined`
  before the first one). It never throws and never does I/O.
- `provider.maybeRefresh(tickIndex)` is **fire-and-forget**. `runArc` calls it
  once per tick and never `await`s it. It may *start* a background fetch; it
  returns immediately.

Refresh is **doubly gated** to spend credits sparingly: a fetch starts only when
the slow cadence is due (`poll_every_n_ticks`) **and** the cache is stale
(`cache_ttl_ms`). A single in-flight request is **deduped**, so a burst of ticks
never fans out into parallel calls. An optional `maxCalls` budget hard-stops new
fetches once exhausted.

### 2. Read-only into `context`, never into execution — fail-open

The snapshot is placed in `context.signals.nansen` and is visible to `decide`
only. Because a seed agent's `decide` returns an Intent that **never embeds
`signals`**, the value is structurally unable to reach signing, the referee, or
the rail. Any client failure (timeout, `429`, `5xx`, malformed JSON) is
**swallowed** inside the provider; the last good snapshot stays in place, so a
broken or absent Nansen never stalls or perturbs the arc.

This is proven, not asserted by convention:
[`tests/e2e/signals.nansen.e2e.test.ts`](../tests/e2e/signals.nansen.e2e.test.ts)
signs the **entire arc twice** — once with the leader's Nansen signal injected,
once empty — and requires the signed Intent bytes to be **byte-identical**.

## Default-off ⇒ byte-identical arc

A live snapshot carries a wall-clock `fetchedAtMs` and is therefore
**non-deterministic**. So the signal is **opt-in**:

- With **no `NANSEN_API_KEY`**, `loadNansenSignalProvider()` returns `null`. A
  `null` provider wired into `runArc` is a no-op: every agent's `signals` is
  `{}`, and the arc is byte-identical to a no-signal run.
- Even when enabled, the seed strategies **ignore `context.signals`**, so the
  produced Intents — and thus the deterministic arc/score — are unchanged. The
  integration test runs `runArc` with a live, *flapping* provider and asserts the
  end-state (crashed agents, final allocations) equals the baseline run.

## Trust boundary & secrets

- `NANSEN_API_KEY` is read in exactly one place,
  [`lib/signals/nansen/load.ts`](../lib/signals/nansen/load.ts) (`server-only`),
  and flows only into the client's `apiKey` request header — never into a
  response DTO, an agent's `context`, a log line, or an `executions` payload.
- Untrusted input = the HTTP response. It is parsed defensively (zod, tolerant of
  key aliases and envelope shapes), bounded (response body ≤ 2 MiB, rows ≤ 50),
  and any value that is not a finite number is dropped. A response that cannot be
  confidently normalized becomes a typed `NansenParseError` — never partial or
  guessed data.
- Usage/credit observability is emitted via `NansenLogger` events
  (`fetch_start` / `fetch_success` / `fetch_error` / `budget_exhausted`) that
  carry only counts and a static endpoint label — never secrets or response
  bodies. The logger is treated as fallible: every emit is wrapped, so a sink
  that throws can never reject the detached fetch or throw into the tick.
- Because the key rides in a request header, the endpoint is **`https`-only**
  (enforced by the config schema) and the client uses `redirect: 'error'` — it
  refuses to follow a redirect that could replay the credential to another
  origin. The wall-clock timeout spans the whole round-trip (connect **and**
  body read), so a slow-drip body cannot hang the fetch; the row scan is capped
  independently of output, so a hostile all-empty array cannot stall the loop.

## Wiring (opt-in)

```ts
import { loadNansenSignalProvider } from '@/lib/signals/nansen/load';
import { runArc } from '@/lib/replay';

const nansen = loadNansenSignalProvider({ maxCalls: 100, logger });
await runArc(db, arc, { nansen: nansen ?? undefined });
```

`loadNansenSignalProvider` returns `null` when the key is absent (the safe
default), so passing it through keeps a keyless deployment on the byte-identical
path.
