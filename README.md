# Vector

**The merit layer for autonomous capital on Mantle.**

A bounded-execution **referee** (firewall) + reputation **scoring** (AgentScore
0–100) + a reputation-weighted **capital router**, anchored on-chain by an
ERC-8004 Reputation Registry on Mantle testnet. Demo rail: Byreal Perps CLI.
The product is a deterministic 90-second arc: merit → blocked theft →
reputation collapse → capital reroute.

Built for **Mantle: The Turing Test Hackathon 2026** — track *Agentic Wallets &
Economy*.

## The pipeline

Vector is not three demos — it is one real, deterministic pipeline. The same
referee, scoring and router used in production drive a frozen 90-second arc, so
the demo is honest (no mocked verdicts) and reproducible (same seed ⇒
byte-identical run).

```
signal → decide → intent → referee → execution → outcome
                                                     │
                                                   score (AgentScore 0–100)
                                                     │
                                       on-chain anchor (ERC-8004 on Mantle)
                                                     │
                                          capital re-route (pool conserved)
```

- **Referee (firewall).** A pure, deterministic gate over *typed, signed Intents*
  (never prompts). A fixed, ordered rule set reduces each Intent to
  `HALT/REJECT/CLIP/ALLOW`; blocking rules dominate soft clips. Rule #3
  `fresh_wallet_transfer_block` rejects a drain to a non-whitelisted wallet
  `hard` — the load-bearing security property. See [docs/referee.md](./docs/referee.md).
- **AgentScore ∈ [0,100].** A pure scoring function whose *only* exposure input is
  capital-at-risk (`car_r`), not trade count or volume — the structural root of
  its anti-wash / anti-Sybil property. A confirmed drain floor-crashes the score.
  See [docs/scoring.md](./docs/scoring.md).
- **Reputation-weighted capital router.** Moves a fixed, *exactly conserved*
  capital pool toward the highest scores in bounded, stable steps; a blocked
  theft drains the offender and reroutes to the honest leaders. See
  [docs/capital-router.md](./docs/capital-router.md).

## On Mantle (on-chain)

Per-round agent feedback is anchored on the **canonical ERC-8004 Reputation
Registry** already deployed on **Mantle Sepolia** (`chainId 5003`). Vector reads/
writes the shared singletons — it does not deploy its own.

| Contract           | Address                                      |
| ------------------ | -------------------------------------------- |
| ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| IdentityRegistry   | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |

`giveFeedback(...)` is authorized by `msg.sender` (no off-chain signature); the
feedback author must differ from the agent's owner/operator. See
[docs/erc8004-registry.md](./docs/erc8004-registry.md).

**Real venue, not a sim:** allowed Intents can settle on the real Byreal Perps
testnet venue via the official `@byreal-io/byreal-perps-cli` — a real on-venue
order id + PnL next to the demo. Byreal fills and the read-only Nansen
smart-money signal are optional side-channels that **never** feed the
deterministic scoring arc (default-off ⇒ byte-identical run). See
[docs/byreal-rail.md](./docs/byreal-rail.md) and [docs/nansen-signal.md](./docs/nansen-signal.md).

## Demo — the 90-second arc

Two seed agents (`seed-leader`, `seed-2`). On the penultimate round an operator
injects a fund-draining `transfer` from the leader → the referee blocks it →
scoring crashes the leader → the router reroutes its capital to the honest
runner-up, pool conserved to the last unit. Entry point `runArc(db, DEMO_ARC)`;
determinism is pinned by golden + e2e + fuzz + integration tests. See
[docs/demo-spine.md](./docs/demo-spine.md).

## Stack

Next.js (App Router) · TypeScript (strict) · Neon/Postgres · SWR polling (no
sockets) · zod · **Bun** (package manager, runtime, test runner).

## Quickstart

Requires [Bun](https://bun.sh) ≥ 1.3.

```bash
bun install
cp .env.example .env.local   # set DATABASE_URL (Neon postgres:// string)
bun run dev                  # http://localhost:3000
```

Health: `GET /api/health` runs a real `SELECT 1` and returns
`{ ok, db, config_loaded, commit }` (200 up / 503 down).

## Scripts

```bash
bun run dev | build | start
bun run typecheck            # tsc --noEmit
bun run lint                 # eslint .
bun run test                 # unit + fuzz + e2e (integration auto-skips w/o DB)
bun run test:integration     # needs DATABASE_URL; run in its own process
```

> ⚠️ `bun run build` requires a valid `DATABASE_URL`. The API route modules
> read `ENV` at import, which is validated eagerly when Next collects page data
> at build time, so a build without the variable fails fast. This is expected
> for the Vercel deploy (where `DATABASE_URL` is set); set it locally to build.

## Docs

- [docs/demo-spine.md](./docs/demo-spine.md) — the deterministic 90-second arc.
- [docs/referee.md](./docs/referee.md) · [docs/scoring.md](./docs/scoring.md) ·
  [docs/capital-router.md](./docs/capital-router.md) — the three core engines.
- [docs/erc8004-registry.md](./docs/erc8004-registry.md) — on-chain ERC-8004
  integration on Mantle Sepolia.
- [docs/byreal-rail.md](./docs/byreal-rail.md) · [docs/nansen-signal.md](./docs/nansen-signal.md)
  — the credibility rail and smart-money signal (optional side-channels).
- [docs/config.md](./docs/config.md) — every constant, default and §ARCH ref.
- [docs/env.md](./docs/env.md) — env variables, formats, secret handling.
- [docs/adr/0001-…](./docs/adr/0001-seeded-config-and-swr-polling.md) — why one
  seeded config + SWR polling (not sockets).
