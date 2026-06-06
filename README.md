# Vector

**The merit layer for autonomous capital on Mantle.**

A bounded-execution **referee** (firewall) + reputation **scoring** (AgentScore
0–100) + a reputation-weighted **capital router**, anchored on-chain by an
ERC-8004 Reputation Registry on Mantle testnet. Demo rail: Byreal Perps CLI.
The product is a deterministic 90-second arc: merit → blocked theft →
reputation collapse → capital reroute.

> **Stage P0.1 — App Skeleton & Seeded Config.** Foundation only: app skeleton,
> DB client, env/secrets, SWR data layer, and the single immutable seeded config
> that makes the demo deterministic. Scoring, referee and on-chain writes land
> in later stages.

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

## Docs

- [docs/config.md](./docs/config.md) — every constant, default and §ARCH ref.
- [docs/env.md](./docs/env.md) — env variables, formats, secret handling.
- [docs/adr/0001-…](./docs/adr/0001-seeded-config-and-swr-polling.md) — why one
  seeded config + SWR polling (not sockets).
