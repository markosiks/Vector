# Vector Read API (P1.5)

SWR-pollable read endpoints that back the demo UI: the leaderboard, agent
detail, the policy-event red-alert feed, and the ERC-8004 attestation mirror.

The machine-readable contract is [`openapi.json`](./openapi.json), generated
from the same zod DTOs the routes serialize (`bun run api:openapi`) — so it
cannot drift from the code.

## Conventions

- **Runtime.** Every route is `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`.
- **Caching.** Every response is `Cache-Control: no-store`. The UI polls on a
  fixed cadence (`CONFIG.timing.ui_poll_ms`) and the policy feed is a
  near-real-time alert channel; a cached copy would show stale REJECT/HALT state.
- **Precision.** Money, score, weight, and capital-at-risk values are Postgres
  `numeric`, returned as **exact decimal strings**, never JSON numbers. Routing
  one through a float would corrupt a `numeric(38,18)` position or a 39-digit
  attestation value.
- **Timestamps.** `*_at` fields are ISO-8601 strings (UTC).
- **No internal leakage.** The intent shape never includes `signature`,
  `raw_json`, or `nonce`.

## Errors

Every request resolves to one of three outcomes: a typed result, a client error
(`4xx`, safe to echo), or a server/dependency error (`5xx`, no internal detail).
The body is always:

```json
{ "error": { "code": "invalid_limit", "message": "limit must be a positive integer" } }
```

| Status | When                                                          |
| ------ | ------------------------------------------------------------- |
| `400`  | Malformed `limit`, `cursor`, `chain_state`, or path `id`.     |
| `404`  | A well-formed agent `id` that matches no row.                 |
| `503`  | The database is unreachable (retryable).                      |
| `500`  | Any other unexpected error (generic; never leaks internals).  |

A malformed `id` is `400 invalid_id`; a well-formed-but-missing one is
`404 agent_not_found` — kept distinct so an id probe never reads as a real miss.

## Pagination (feeds)

`/api/policy-events` and `/api/attestations` use **keyset (seek) pagination**,
ordered `created_at DESC, id DESC`. The `id` tie-break makes paging deterministic
when many rows share a `created_at` tick (REJECT/HALT bursts, batch reconciles) —
an order a `created_at`-only sort would shuffle across pages.

- `?limit=` bounds the page: `1..200`, default `50`. Out-of-range or non-integer
  → `400`. (A huge value is clamped to `200`, not rejected.)
- The response envelope is `{ "data": [...], "next_cursor": "..." | null }`.
- `next_cursor` is **non-null only when the page is full** (`data.length === limit`)
  — the sole signal that more rows may exist. A short page is terminal.
- Pass it back as `?cursor=`. The cursor is an opaque base64url token pinning the
  last row's `(created_at, id)`; tampering or a malformed token → `400`.

New rows arriving at the head do not disturb an in-flight backward walk: paging
continues strictly *older* than the cursor, so there is no gap and no duplicate.

## Endpoints

### `GET /api/leaderboard`

Agents ranked by current AgentScore (`score_current DESC, created_at ASC`), each
LEFT JOINed to its capital allocation in the **current round** (the highest
`index`). Returns the round status and the capital unit label
(`CONFIG.capital.capital_unit_label`).

| Query   | Type    | Notes                  |
| ------- | ------- | ---------------------- |
| `limit` | integer | `1..200`, default `50` |

```jsonc
{
  "round": { "id": "…", "index": 4, "state": "open", "started_at": "…", "settled_at": null },
  "capital_unit": "tMNT",
  "data": [
    {
      "id": "…",
      "display_name": "…",
      "owner": "…",
      "strategy_kind": "seed",
      "status": "active",
      "score_current": "73.250",
      "agent_id_onchain": null,
      "allocation": "250000.123456789012345678", // null if unfunded this round
      "created_at": "…"
    }
  ]
}
```

Before any round exists, `round` is `null` and every `allocation` is `null`.

### `GET /api/agents/{id}`

One agent's detail. The EWMA score history is ordered by **round index** (not
insertion time), so a backfilled or replayed round renders in sequence. Recent
intents, the referee decisions on them, and recent outcomes are returned side by
side; the UI correlates a decision to its intent by `intent_id`.

| Param   | In    | Notes                                    |
| ------- | ----- | ---------------------------------------- |
| `id`    | path  | Agent UUID. Malformed → 400; unknown → 404 |
| `limit` | query | bounds intents/events/outcomes           |

Response: `{ agent, scores[], intents[], policy_events[], outcomes[] }`.

### `GET /api/policy-events`

The red-alert feed of referee decisions (`REJECT`/`HALT`/`CLIP`/`ALLOW`) across
all agents, newest first. Keyset-paginated.

| Query    | Type    | Notes                  |
| -------- | ------- | ---------------------- |
| `limit`  | integer | `1..200`, default `50` |
| `cursor` | string  | opaque keyset cursor   |

### `GET /api/attestations`

ERC-8004 attestation records mirrored in Neon, newest first, with their
`chain_state`, `tx_hash`, and `block_number`. Keyset-paginated, with an optional
state filter.

| Query         | Type    | Notes                                       |
| ------------- | ------- | ------------------------------------------- |
| `limit`       | integer | `1..200`, default `50`                      |
| `cursor`      | string  | opaque keyset cursor                        |
| `chain_state` | enum    | `optimistic` \| `confirmed` \| `failed`     |

The filter and the cursor are independent and compose.

## SWR usage

```ts
const { data } = useSWR('/api/leaderboard', fetcher, {
  refreshInterval: CONFIG.timing.ui_poll_ms,
});
```

For the feeds, poll page 1 for the live head and follow `next_cursor` for
history. Because the order is a stable keyset, a newly written event simply
appears at the head on the next poll without perturbing deeper pages.
