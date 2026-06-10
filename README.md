# Vector

**The merit layer for autonomous capital on Mantle.**

Vector is a trust rail for autonomous agents that move capital. It combines three
pieces into one deterministic loop:

1. **Referee (firewall)** — a bounded-execution gate that validates every signed
   *Intent* (anti-replay nonce, TTL, policy limits) and verdicts it `ALLOW` /
   `CLIP` / `BLOCK` **before** any capital can move.
2. **AgentScore (0–100)** — a deterministic reputation score derived from an
   agent's realized behavior (PnL, policy hygiene, capital-at-risk).
3. **Reputation-weighted capital router** — allocates capital as a function of
   AgentScore and eligibility, and reroutes it when reputation collapses.

The whole thing is **anchored on-chain on Mantle**: agent identity + feedback on
the canonical ERC-8004 registries, plus Vector's own merit-attestation contract
(`VectorMeritRegistry`). The product demo is a deterministic arc:
**merit → blocked theft → reputation collapse → capital reroute.**

> **Status (2026-06):** P0–P3 implemented. The on-chain anchor is live and
> verified on Mantle Sepolia (see *On-chain* below). The default demo arc runs on
> deterministic seeded data so it never stalls; live signals (Elfa) and a live
> execution venue (Byreal Perps testnet) are wired and turn on automatically when
> their credentials are present. **Testnet only** — no mainnet / real-money path.

## Stack

Next.js (App Router) · TypeScript (strict) · Neon/Postgres · viem · SWR polling
(no sockets) · zod · **Bun** (package manager, runtime, test runner) ·
Foundry + OpenZeppelin (the on-chain contract, under `contracts/`).

## On-chain (Mantle Sepolia · chainId 5003)

RPC: `https://rpc.sepolia.mantle.xyz`

**Vector's own contract — `VectorMeritRegistry`** (self-deployed, source-verified):

| | |
|---|---|
| Address | `0x00dD1EE8dC51B8Fb704487feBa103cf782c6AB12` |
| AI function (on-chain) | `attestScore(uint256 agentId, uint16 score, bytes32 evidenceHash)` |
| Reads | `latestScore(agentId)`, `isEligible(agentId, minScore)` |
| Owner / Attestor | `0x1eB8FF35d7d66CE31EB11FdeC966756279EC0F75` / `0xAdf0997bEEB5d6C8A6A2E9C31a8A5A4638C90858` |
| Verification | **Sourcify `exact_match`** (creation + runtime) — [lookup](https://sourcify.dev/#/lookup/0x00dD1EE8dC51B8Fb704487feBa103cf782c6AB12) |
| Explorer | [Blockscout](https://explorer.sepolia.mantle.xyz/address/0x00dD1EE8dC51B8Fb704487feBa103cf782c6AB12) · [Mantlescan](https://sepolia.mantlescan.xyz/address/0x00dD1EE8dC51B8Fb704487feBa103cf782c6AB12) |

`attestScore` is the AI-callable function: an off-chain scorer publishes an
agent's AgentScore (0–100, stored as 0–1000 with one decimal) plus a keccak256
evidence hash. Score must be in `[0, 1000]` (out of range reverts), the per-agent
nonce is strictly increasing, and only the authorized attestor may write.

Live `attestScore` for `agentId 136`, score `735` (= 73.5):
tx [`0x5b340207…c7de090`](https://explorer.sepolia.mantle.xyz/tx/0x5b340207639633cd3a07660d37e0744eb9002e31a674177e1aef28814c7de090) →
`latestScore(136)` = `{735, nonce 1, exists}`, `isEligible(136, 700)` = `true`,
`isEligible(136, 800)` = `false`.

**Canonical ERC-8004 registries** (Vector reads/writes these, does *not* redeploy them):

| Registry | Address |
|---|---|
| Identity | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| Reputation | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

Live `register → giveFeedback`: agent `tokenId 136` registered by the operator;
feedback (AgentScore 73.5) written by the attestor —
tx [`0x99101710…41874e9`](https://explorer.sepolia.mantle.xyz/tx/0x99101710c82bfc64fd37cb838c4c9426402cc91ebbdf6931b17aca36841874e9).
The two-key model is mandatory: the registry rejects self-feedback, so the
operator (agent owner) and attestor are distinct EOAs.

> 🔐 Private keys are never committed. The repo tracks only `.env.example`;
> `.gitignore` covers `.env*` / `*.key`. The on-chain wallets above are throwaway
> testnet keys, set only via environment at run time.

## Quickstart

Requires [Bun](https://bun.sh) ≥ 1.3.

```bash
bun install
cp .env.example .env.local   # set DATABASE_URL (Neon postgres:// string), see docs/env.md
bun run dev                  # http://localhost:3000
```

Health: `GET /api/health` runs a real `SELECT 1` and returns
`{ ok, db, config_loaded, commit }` (200 up / 503 down).

## Scripts

```bash
bun run dev | build | start
bun run typecheck            # tsc --noEmit
bun run lint                 # eslint .
bun run test                 # unit + fuzz + e2e (DB/live suites auto-skip without creds)
bun run test:integration     # needs DATABASE_URL; runs in its own process
bun run test:e2e:live        # live arena run (needs DATABASE_URL + RPC/keys)
```

> ⚠️ `bun run build` requires a valid `DATABASE_URL`: API route modules read and
> validate `ENV` eagerly at build time, so a build without it fails fast. This is
> expected for the Vercel deploy (where `DATABASE_URL` is set); set it locally to
> build.

### Tests

The suite is large and runs in tiers: `unit` and `fuzz` need no external
services; `integration` and `e2e` self-provision an isolated throwaway schema
against a **real Neon** `DATABASE_URL` (and cleanly skip without one); the live
chain / signal / venue suites turn on when `MANTLE_TESTNET_RPC_URL`,
`OPERATOR_PRIVATE_KEY` / `ATTESTOR_PRIVATE_KEY`, `ELFA_API_KEY`, or the
`BYREAL_PERPS_*` credentials are present.

## Contracts

The on-chain contract and its Foundry toolchain live in `contracts/`
(forge-std + OpenZeppelin vendored). It is excluded from the app's `tsconfig` /
ESLint.

```bash
cd contracts
forge build
forge test -vvv             # 20 tests (unit + fuzz)
```

Deploy / verify / interact steps (no secrets) are in
[docs/final/vector-contract-deployed.md](./docs/final/vector-contract-deployed.md).

## Docs

- [docs/final/vector-contract-deployed.md](./docs/final/vector-contract-deployed.md) — deployed contract, ABI, live tx, reproduction.
- [docs/final/onchain-register-attest-verified.md](./docs/final/onchain-register-attest-verified.md) — canonical ERC-8004 `register → attest` milestone.
- [docs/config.md](./docs/config.md) — every constant, default and §ARCH ref.
- [docs/env.md](./docs/env.md) — env variables, formats, secret handling.
- [docs/adr/0001-…](./docs/adr/0001-seeded-config-and-swr-polling.md) — why one seeded config + SWR polling (not sockets).
