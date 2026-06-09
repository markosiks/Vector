# Kill-switch Console (Operator) — P2.4

The operator safety console (`/operator`) is the human override surface from the
spec's §11.1: a **global HALT**, **per-agent HALT**, and a **scripted-attack**
button. It is intentionally thin — it flips state that the already-built referee
(P1.1), Capital Router (P1.3), and replay attack (P1.4) read. The console never
re-implements the safety logic; it only operates the switches those components
key on, and records every action to an audit log.

## Controls

| Control | Effect | Enforced by |
| --- | --- | --- |
| Global HALT | Sets `kill_switch.active = true` (singleton). | Referee rule #1 (`kill_switch`) HALTs every Intent; Capital Router gates every agent out. |
| Per-agent HALT | Sets `agents.status = 'halted'`. | Referee rule #1b (`agent_halt`) HALTs that agent's Intents; Capital Router gates it out. |
| Scripted attack | Injects the canonical drain into the current leader through the **real** referee. | Referee rule #3 (`fresh_wallet_transfer_block`) REJECTs it `hard` — or a HALT wins if a stop is active. |

Resuming is the same controls in reverse: global HALT off, or per-agent status
back to `active`.

## Authentication

A single shared secret, `OPERATOR_CONSOLE_TOKEN` (≥ 24 chars), gates the console.

- **Fail-closed.** When the env var is unset, the console is *disabled*: the page
  shows a disabled notice and every operator API returns `403`. There is no
  default token.
- **Login.** `POST /api/operator/session { token }` compares the presented token
  to the configured one in **constant time** (`node:crypto.timingSafeEqual`). On
  a match it sets an httpOnly, `SameSite=Strict`, `Secure`-in-prod session cookie
  (`vector_operator`) whose value is `sha256(token)` — never the raw secret. The
  cookie lasts 8h. `DELETE /api/operator/session` clears it.
- **Authorization.** Every mutating/read operator route calls `requireOperator`,
  which rejects an unconfigured console (`403`) or a missing/invalid cookie
  (`401`). The page's server-side gate is UX only; the API is the boundary.
- There is no per-user identity; the audit `actor` is the constant `'operator'`.

## API

All routes are `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, operator-gated.

| Method & path | Body | Returns |
| --- | --- | --- |
| `POST /api/operator/session` | `{ token }` | `204` + session cookie (`401`/`403` on failure) |
| `DELETE /api/operator/session` | — | `204`, clears cookie |
| `GET /api/operator/state` | — | `{ kill_switch, agents, capital_unit, round, recent_actions }` |
| `POST /api/operator/kill-switch` | `{ active, reason? }` | the new `kill_switch` DTO |
| `POST /api/operator/agents/:id/status` | `{ status }` | the updated agent DTO (`404` if unknown) |
| `POST /api/operator/attack` | `{ idempotency_key }` (uuid) | `{ decision, severity, rule_fired, intent_id, intent_hash, duplicate, target_* }` |

### Atomicity

Each mutation runs inside `withTransaction`: the state change and its
`operator_actions` audit row commit together (or roll back together). A torn
write that toggled the switch with no audit trail — or audited an action that did
not commit — is therefore impossible.

### Idempotency of the scripted attack

The injected drain's `nonce` is `op-attack:<idempotency_key>` (a per-click uuid).
The durable `(agent_id, nonce)` unique constraint makes a retried or
double-submitted click a no-op: the reservation loses the race and returns
`null`, so **no second Intent, no second `policy_event`, and no duplicate audit
row** are written. The decision is still reported on the retry — re-derived by the
pure `evaluate` — so the client sees a transparent, idempotent result
(`duplicate: true`, `intent_id: null`).

The drain is signed with the target seed agent's key and run through the **real**
`runReferee`, so its REJECT is a genuine `policy_event` visible in the P1.5 feed —
not a simulated banner.

## Audit log

`operator_actions` (migration `0007`) records every mutation: `kind`
(`kill_switch` | `agent_status` | `attack`), `actor`, optional `agent_id`, a
`detail_json` blob, and `created_at`. `GET /api/operator/state` returns the most
recent rows; the console renders them as a feed.

## Data model

- `kill_switch` — pre-existing singleton (`id = 1`), upserted atomically. A
  missing row is the fail-open default (inactive).
- `agents.status` — pre-existing (`active` | `halted` | `gated`); the operator
  writer is `setAgentStatus` (the scoring writer preserves a `halted` status).
- `operator_actions` — new audit table (0007). Reversible via `0007_*.down.sql`.

## Referee change

Per-agent HALT needed an execution cut at the referee (routing already gated on
`status='halted'`). A new blocking rule `agent_halt` was added at index 1 — after
the global `kill_switch`, before any content rule — driven by a new
`RefereeState.agent.halted` flag (defaulting to "not halted" so pre-P2.4 states
are unchanged). The orchestrator threads `status === 'halted'` into that flag.

## Tests

- **Unit** (`tests/unit/operator/`): token core (constant-time, fail-closed,
  session digest), the `agent_halt` rule + its ordering in `evaluate`, the DTO
  mappers, and the repos (parameterized SQL via a fake `Queryable`).
- **Fuzz** (`tests/fuzz/operator.fuzz.test.ts`): the token comparator never
  accepts a wrong credential and never throws on junk input.
- **Integration** (`tests/integration/operator.integration.test.ts`, gated on
  `DATABASE_URL`): kill-switch + audit, per-agent status, attack → REJECT with a
  persisted `policy_event`, idempotent retry writes nothing new, and both HALT
  modes turn the injected drain into a HALT.
- **Browser e2e** (`tests/browser/operator.live.spec.ts`, gated on
  `OPERATOR_LIVE=1`): login → scripted-attack REJECT → global HALT → resume,
  against a live server with a seeded database.

## Operations

- Set `OPERATOR_CONSOLE_TOKEN` to a strong secret in every deployment that should
  expose the console. Leave it unset to disable the console entirely.
- The token is a shared operator credential; rotate it by changing the env var
  (which also invalidates outstanding session cookies, since the cookie stores a
  hash of the then-current token).
