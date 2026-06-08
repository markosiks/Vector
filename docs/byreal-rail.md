# Byreal Perps rail — the credibility layer (P2.1)

The Byreal rail settles **already-allowed** Intents on the real
Byreal/Hyperliquid **testnet** venue through the official
[`@byreal-io/byreal-perps-cli`](https://www.npmjs.com/package/@byreal-io/byreal-perps-cli),
and maps the resulting fills/PnL onto Vector's `executions`/`outcomes`. It is the
**honesty/credibility layer** of Stage 2: a judge can point at a real on-venue
order id and PnL next to the demo, proving the merit layer drives a real rail —
not a simulation.

Code: [`lib/rail/byreal/`](../lib/rail/byreal). Tests:
`tests/unit/byreal.*.test.ts`, `tests/fuzz/byreal.fuzz.test.ts`,
`tests/integration/byreal.integration.test.ts`, `tests/e2e/byreal.e2e.test.ts`.

## The determinism boundary (§3) — the load-bearing rule

Real venue PnL is **non-deterministic** (fills, slippage, liquidity vary
run-to-run). The 90-second demo arc and the score **must** be reproducible, so:

> **Byreal outcomes are shown alongside the demo but never feed the
> deterministic scoring arc. Scoring reads only the seeded outcomes
> (`rail = 'seed'`).**

This is enforced structurally, not by convention:

- The seed settlement is unchanged: it writes `executions(rail='seed')` +
  `outcomes`, and **only** those feed scoring.
- The Byreal rail is an **opt-in side-channel** (`RunArcOptions.credibilityRail`),
  not the scoring rail (`RunArcOptions.rail`). It writes a *separate*
  `executions(rail='byreal')` + `outcomes` pair per settled Intent.
- The scoring read is
  [`listSeedOutcomesByAgentRound`](../lib/db/repos/outcomes.ts): it excludes
  `rail='byreal'` outcomes (`WHERE e.rail = 'seed' OR o.execution_id IS NULL`).
- **Default-off:** with no credentials the rail is disabled, no `byreal` rows are
  written, and the arc is **byte-identical** to the seed-only run
  (`tests/unit/replay.arc.golden.test.ts` stays green; the integration test
  asserts identical scores with and without the rail enabled — verified against a
  real Neon Postgres: enabling the rail writes the `byreal` rows yet leaves the
  `scores` rows byte-identical to a seed-only run).

## VERIFY V3 — resolved

The CLI was installed and probed against the live read-only API:

- `@byreal-io/byreal-perps-cli@0.3.7` exists on npm; every command supports
  `-o json`.
- **Envelope** (every command): `{ success, meta:{timestamp,version},
  data?|error?:{code,message} }`. `parseEnvelope` validates this and is hardened
  against banners, ANSI, truncation, and oversized output.
- **Credentials** are env-injected: `BYREAL_PERPS_AGENT_KEY` (scoped session key)
  + `BYREAL_PERPS_WALLET_ADDRESS`. Non-interactive `account info -o json` was
  confirmed to work with env creds — the sole-custody model we need.
- **Network** (testnet vs mainnet) is selected by the CLI's *stored account
  config* (`account init`, sqlite under `~/.config/byreal-perps`), keyed by
  `HOME` — **not** a pure env var. The adapter therefore (a) requires the
  operator to provision a testnet account and (b) refuses `mainnet` credentials
  unless `BYREAL_PERPS_NETWORK=mainnet` is set *and* `allowMainnet` is passed, so
  a misconfiguration can never place real-money orders. As defense-in-depth the
  child env also carries `BYREAL_PERPS_NETWORK` pinned to the validated network;
  this only hardens CLI versions that honour the var — the load-bearing guard
  remains the construction-time refusal of `mainnet` credentials. Operators must
  still ensure the provisioned `HOME` account points at testnet.

**Caveat (operator action required for a live round-trip):** a *funded* testnet
Solana/Privy account cannot be self-provisioned autonomously. The DoD's live
round-trip needs an operator to supply funded testnet credentials. Per spec this
is acceptable: with no/invalid creds the rail degrades silently to the seeded
path and the demo is unaffected.

## Architecture (B4 — cross-venue settlement)

```
Intent (ALLOW/CLIP only) ──► createByrealRail.execute()
                                │  buildSettlementCommand → argv (no shell)
                                ▼
                         runByrealCli  ── spawn(execPath, [cli, -o json, -y, …])
                                │           minimal child env: PATH, HOME, KEY, WALLET
                                ▼
                         parseEnvelope → parseOrderResult (+ position read)
                                │
                                ▼
                         RailFill → executions(rail='byreal') + outcomes
                                        (credibility surface; excluded from scoring)
```

Vector's merit layer runs on **Mantle**; the trading venue is
**Byreal/Hyperliquid testnet**. The rail is the B4 seam between them: the agent
proposes an Intent (B2 — agents never hold venue keys), the referee allows it,
and only then does the rail translate it to a venue order using the scoped key it
alone holds.

## [CORE] scope

Supported (expressible from the referee-validated Intent contract):

| Intent action        | CLI command                              |
| -------------------- | ---------------------------------------- |
| `open`               | `order market <side> <size> <coin> [--tp][--sl]` |
| `close`              | `position close-market <coin> <size>`    |
| `modify` (TP/SL)     | `position tpsl <coin> [--tp][--sl]`      |
| read PnL / positions | `account info`, `position list`          |

Markets are whitelisted and mapped to coins in
[`markets.ts`](../lib/rail/byreal/markets.ts) (`BTC-PERP→BTC`, `ETH-PERP→ETH`); a
load-time invariant asserts the rail map is a **subset** of
`CONFIG.policy.market_whitelist`.

**Out of scope:** full position management, multi-account, advanced margin.

**Limit orders — [ROADMAP].** The Intent contract carries no price field, so a
limit price is not expressible today. `buildSettlementCommand` returns `null`
(defer to seed) for anything it cannot express. Adding limit support is a
follow-up gated on a `price` field on the Intent schema.

## Safety & isolation guarantees

- **Only ALLOW/CLIP reach the rail.** The orchestrator calls the rail only after
  the referee verdict; a `transfer` is REJECTed by the referee and additionally
  has no command builder, so the rail can never move funds.
- **No shell injection.** Commands are argv arrays handed to `spawn` with no
  shell. Coins come only from the frozen whitelist; numeric fields are validated
  against a strict decimal grammar (fuzz-tested) — a malformed value throws
  rather than reaching argv.
- **Credential sole-custody.** `loadByrealCredentials` (server-only) is the only
  reader of the key. The CLI child gets a *minimal* env (`PATH`, `HOME`, key,
  wallet) — the parent's other secrets are **not** inherited. The key never
  appears in argv, logs, responses, or `executions.response_json`.
- **Bounded.** Per-command timeout (SIGTERM→SIGKILL) and a stdout cap; a hung or
  runaway CLI is killed.
- **Silent fallback.** Any miss — empty/illiquid market, non-success envelope,
  parse failure, timeout, crash — returns `null`/throws, which the seed fallback
  (`settleWithFallback`) and the credibility wrapper both degrade to the seeded
  outcome. The arc never stalls.
- **Idempotency.** Keyed by `intent_hash`: a retry/re-run reuses the first fill
  and never places a second order. The default store is process-local
  (`createMemoryIdempotencyStore`); a deployment needing durable cross-process
  idempotency supplies a store backed by the unique `executions.rail_order_id`.

### Outcome mapping notes

`pnl_realized` (closes), `pnl_marked` and `capital_at_risk` (from the position
read), `fees`, and `position_delta` (signed fill size) are venue-derived.
`drawdown` is fixed to `'0'`: it is a scoring-only quantity not derivable per-fill
from the venue, and Byreal outcomes never feed scoring. A failed best-effort
position read leaves `pnl_marked`/`capital_at_risk` at `'0'` rather than
discarding a real fill.

## Configuration

| Env var                       | Required | Purpose                                  |
| ----------------------------- | -------- | ---------------------------------------- |
| `BYREAL_PERPS_AGENT_KEY`      | to enable | Scoped session key (secret, sole-custody) |
| `BYREAL_PERPS_WALLET_ADDRESS` | to enable | Wallet the key authorizes (0x EVM addr)  |
| `BYREAL_PERPS_NETWORK`        | no       | `testnet` (default) / `mainnet` (guarded) |
| `BYREAL_PERPS_CLI_PATH`       | no       | Explicit CLI entry; else package-resolved |

Wire it in:

```ts
import { createByrealRail, loadByrealCredentials } from '@/lib/rail/byreal';

const credentials = loadByrealCredentials(); // null ⇒ disabled (default)
const credibilityRail = credentials ? createByrealRail({ credentials }) : undefined;
await runArc(db, arc, { ...(credibilityRail ? { credibilityRail } : {}) });
```
