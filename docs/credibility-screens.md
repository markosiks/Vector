# Credibility Screens (P2.3)

Two read-only surfaces that make an agent's on-chain reputation legible:

- **Attestation Log — `/attestations`**: the per-round ERC-8004 attestation
  records mirrored in Neon, newest first, each carrying its reconciliation
  `chain_state` (`optimistic` → `confirmed` / `failed`), `tx_hash`,
  `block_number`, and an explorer deep-link on Mantle Sepolia.
- **Agent detail — `/agents/{id}`**: one agent's credibility story — its EWMA
  score curve, the **explicit** composition of the latest score, the referee's
  verdicts on its recent intents, and the settlement outcomes.

Like the Arena (P1.6), these are thin rendering shells over pure logic. All
behaviour — score composition, chain-state semantics, EWMA geometry,
intent↔referee correlation, explorer-link validation, formatting — lives in
[`lib/credibility/`](../lib/credibility) as **total functions over plain data**,
unit-, fuzz-, integration-, and browser-tested independently of React.

## Data sources — read-only, no backend changes

The screens consume only the **P1.5 read API** (see [`read-api.md`](./read-api.md)).
No endpoints, repos, DTOs, or schema were added or changed for P2.3.

| Screen | Endpoint | Used for |
| --- | --- | --- |
| Attestation Log | `GET /api/attestations?limit=&chain_state=&cursor=` | keyset feed of attestation records + chain state |
| Agent detail | `GET /api/agents/{id}` | `{agent, scores[], intents[], policy_events[], outcomes[]}` |

Both poll on the **single app-wide cadence** `CONFIG.timing.ui_poll_ms`,
configured once in [`app/providers.tsx`](../app/providers.tsx) (SWR
`refreshInterval`). SWR polling only — no sockets. The Attestation Log pages with
`useSWRInfinite` over the repo's `(created_at, id)` keyset cursor; the detail
screen is a single `useSWR`.

## The score formula is shown explicitly

The breakdown never renders a flat sum. It reconstructs, term by term, the
scorer's raw round score:

```
raw_r = clamp(100 · perf · w  +  policy  −  dd,  0, 100)
```

- `perf`, `w` are **unit factors** in `[0, 1]` (shown as `0.xx`),
- `policy`, `dd` are **point-scale** contributions on the 0–100 axis,
- the multiplicative `100 · perf · w` is rendered as its own term so a low
  `perf` or `w` is visibly the cause of a low score,
- when the raw value is clamped, a **clamp note** marks it.

The components come from the score's `components_json` (`{perf, w, policy, dd}`).
[`breakdownFrom`](../lib/credibility/components.ts) validates them with the
project's `scoreComponents` zod schema (`.strict()`), so a broken/extra-field
DTO degrades to an empty state rather than a wrong number. An integration test
proves the reconstructed `raw` matches the scorer's stored `raw_r` to 4 dp.

## Chain state & explorer links

[`chain-state.ts`](../lib/credibility/chain-state.ts) maps the three
`CHAIN_STATE` values to a `{label, tone, terminal, description}` and flags a
**stuck** optimistic row (`isStuckOptimistic`, budget `STUCK_OPTIMISTIC_MS`) so a
record that never reconciles is visibly distinct from a fresh one.

[`explorer.ts`](../lib/credibility/explorer.ts) treats `tx_hash`,
`block_number`, and addresses as **untrusted**: a malformed value yields `null`
(rendered as plain text, never a broken link), a well-formed one yields a
canonical `…/tx/0x…` / `…/block/N` URL from `CONFIG.chain.mantle_explorer_base_url`.

## Files

| Area | Path |
| --- | --- |
| Pure logic | [`lib/credibility/`](../lib/credibility) (`explorer`, `chain-state`, `components`, `ewma`, `referee`, `format`) |
| Attestation Log UI | [`app/attestations/`](../app/attestations) |
| Agent detail UI | [`app/agents/[id]/`](../app/agents/[id]) |
| Unit | `tests/unit/credibility.*.test.ts` |
| Fuzz | `tests/fuzz/credibility.fuzz.test.ts` |
| Integration (DB-gated) | `tests/integration/credibility.integration.test.ts` |
| E2E (route handler) | `tests/e2e/credibility.e2e.test.ts` |
| Browser (Playwright) | `tests/browser/credibility.spec.ts` |

## Edge cases covered

Failed / stuck-optimistic rows; empty feeds and empty sections; long history
(attestations via keyset paging; the agent EWMA history is bounded server-side
to the most recent `SCORE_HISTORY_MAX` rounds so the polled payload and the SVG
path stay bounded); broken DTOs (invalid components, non-decimal `score_r` such as a
hex literal, malformed `tx_hash`); a malformed agent id → explicit not-found (no
retry storm); locale-independent number/score/timestamp formatting (UTC); and a
static, `prefers-reduced-motion`-safe EWMA chart.
