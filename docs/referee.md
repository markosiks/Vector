# Referee / Firewall (P1.1)

The referee is Vector's **bounded-execution gate** (architecture §6.3): the single
path from a validated, signed Intent to the execution rail (boundary B2). It takes
a typed Intent — never a prompt — evaluates it against a **fixed, ordered** rule
set, and reduces it to one of four decisions, emitting one `policy_event` per
decision.

`evaluate(intent, state, config)` is a **pure, deterministic** function: the same
inputs always yield the same decision and the same `policy_event`. Scoring,
routing, and execution live elsewhere — the referee only judges.

## Two-phase rules — blocking decisions dominate soft clips

Evaluation runs in two phases (**order is the single source of truth**, see
`lib/referee/rules/index.ts`). A terminal decision (HALT/REJECT) must always
dominate a soft CLIP — otherwise an over-sized trade could trip an early clip
and pre-empt a later REJECT/HALT, slipping an over-leveraged / over-budget /
drawdown-breached trade through. So:

**Phase 1 — blocking rules (first one that fires decides outright):**

| # | Rule (`rule_fired`)           | Applies to          | Condition                                           | Decision | Severity |
|---|-------------------------------|---------------------|-----------------------------------------------------|----------|----------|
| 1 | `kill_switch`                 | all                 | global kill switch active                           | HALT     | halt     |
| 1b | `agent_halt`                 | all                 | agent halted by operator (`agents.status='halted'`) | HALT     | halt     |
| 2 | `market_whitelist`            | open, modify, close | `market` not in `market_whitelist` (exact match)    | REJECT   | hard     |
| 3 | `fresh_wallet_transfer_block` | transfer            | destination not on address whitelist (or missing)   | REJECT   | hard     |
| 4 | `drawdown_breaker`            | all                 | `drawdown >= dd_breaker`                            | HALT     | halt     |
| 5 | `spend_cap`                   | open, modify        | `remaining_budget <= 0`                            | REJECT   | soft     |

**Phase 2 — clipping rules (run only if nothing blocked; they accumulate):**

| # | Rule (`rule_fired`) | Applies to   | Condition                | Clamp                          |
|---|---------------------|--------------|--------------------------|--------------------------------|
| 6 | `size_cap`          | open, modify | `size > max_trade_size`  | `size → max_trade_size`        |
| 7 | `spend_cap`         | open, modify | `size > remaining_budget`| `size → remaining_budget`      |
| 8 | `leverage_cap`      | open, modify | `leverage > max_leverage`| `leverage → max_leverage`      |

Every breached clip is applied in **one** CLIP: a lone clip is reported with its
own `rule_fired`; when several fire, `rule_fired` joins them with `+` (e.g.
`size_cap+leverage_cap`) and `detail.clips[]` records each rule's rationale. The
result therefore satisfies **all** caps at once — `size <= min(max_trade_size,
remaining_budget)` and `leverage <= max_leverage`.

| — | `allow`          | all                   | no rule fired                        | ALLOW  | none |
| — | `pre_validation` | all (in `runReferee`) | P0.3 structural re-validation failed | REJECT | none |
| — | `internal_error` | all (in `runReferee`) | unexpected error during evaluation   | REJECT | hard |

## Decision / severity semantics

- **ALLOW** — Intent passes unchanged (`severity = none`).
- **CLIP** — a parameter is reduced to a cap (`severity = soft`). The clip
  invalidates the original signature, so the Intent is **never re-signed**: the
  rail executes the post-clip parameters (`modified_intent`), while the original
  `intent_hash`/signature survive in `detail_json` / the `intents` row for audit
  only.
- **REJECT** — Intent dropped. `hard` for the whitelist/transfer rules (the
  reputation-collapsing violations), `soft` for the budget rule, `none` for a
  pre-validation failure.
- **HALT** — agent (drawdown) or everything (kill switch) is frozen
  (`severity = halt`).

## Boundary semantics (why these, exactly)

- **Caps use strict `>`** (rules 4–6): the cap value itself is permitted; only a
  value strictly above it is clipped.
- **The drawdown breaker uses `>=`** (rule 4): a circuit breaker trips on
  *reaching* its limit — `drawdown == dd_breaker` halts. This is the fail-safe
  choice for a risk control, and is deliberately asymmetric to the caps.
- **Blocking beats clipping**: a HALT/REJECT in phase 1 short-circuits before any
  clip runs, so a soft clip can never pre-empt a terminal decision. Within phase
  2 the clips **accumulate** — clipping `size` does not stop the `leverage`/budget
  clamps — so the post-clip Intent always satisfies every cap simultaneously.

## Fresh-wallet criteria (rule 3 — the drain block)

`transfer` is the only fund-moving action (§8.2; "withdraw" is a descriptive
synonym). The address **whitelist** (`policy.fresh_wallet_criteria.whitelist`) is
an explicit override: a whitelisted destination is allowed even if it looks
fresh. **Any** other destination — including a `transfer` with no
`target_address` — is treated as a drain and rejected `hard`.

Wallet **freshness** (`age_seconds < max_age_seconds`, or
`require_zero_history && !has_history`) is supplied as state
(`RefereeState.destination`) because age/history are off-chain facts the referee
cannot derive. Freshness is recorded in `detail_json` (and feeds `drain_r` in
P1.2 via `rule_fired`) but **never softens the decision**: a non-whitelisted
transfer is always REJECT + hard. When destination metadata is absent the
destination is treated as fresh (fail-closed). Address matching is
case-insensitive (EVM addresses are case-insensitive; mixed case is only an
EIP-55 checksum).

Critical invariant, covered by unit + fuzz + e2e tests:
**no `transfer` to a non-whitelisted address is ever ALLOWed or CLIPped.**

## `policy_event` format

Every decision (including `pre_validation`) writes one row via the P0.2
repository (`lib/db/repos/policy-events.ts`):

| column        | value                                                              |
|---------------|--------------------------------------------------------------------|
| `intent_id`   | FK to the persisted `intents` row                                  |
| `agent_id`    | FK to `agents` (uuid — distinct from the Intent's string agent id) |
| `round_id`    | FK to `rounds`                                                     |
| `rule_fired`  | the deciding rule id (table above)                                 |
| `decision`    | `ALLOW` / `CLIP` / `REJECT` / `HALT`                               |
| `severity`    | `none` / `soft` / `hard` / `halt`                                  |
| `detail_json` | structured rationale; the canonical `intent_hash` is folded in here for audit (the table keys on `intent_id`, not the hash) |

`policy_events` is an **append-only** audit log: re-running the referee on the
same Intent yields the same *decision* (evaluate is pure) and appends another
event recording that re-evaluation.

## Responsibility boundary

- **P0.3 (`lib/intent/validate.ts`)** owns *structural* validation — schema,
  signature, nonce, ttl, numeric bounds, target-address shape. `runReferee`
  re-runs it as defense-in-depth before any policy rule; a failure is the
  `pre_validation` REJECT.
- **The referee (here)** owns *trading policy* — whitelist, caps,
  fresh-wallet/drain block, budget, drawdown. No scoring, routing, or execution.
- **P1.2** consumes `policy_events` (`rule_fired`, severity) to compute scoring
  penalties and `drain_r`.

## Security notes

- **Market whitelist is disclosed in REJECT `detail_json`** (`rule_fired: 'market_whitelist'`). The
  full whitelist array is included for operator observability, which is acceptable for the demo
  (the whitelist is non-secret). For production deployments, consider omitting the `whitelist`
  field from the detail, or replacing it with a stable count/hash, to avoid exposing the full
  allow-list to unauthenticated callers of `GET /api/policy-events`.

## Caller contract & non-guarantees

`evaluate` is a **pure judge over an injected `RefereeState` snapshot**: it does
no IO, reads nothing from the DB, and decrements nothing. Several money-safety
properties therefore depend on how the (not-yet-built) orchestrator snapshots
state and serializes submissions. The caller MUST honor these:

- **Budget enforcement is advisory under concurrency.** The spend cap is
  evaluated against the injected `remaining_budget`; the referee never reserves
  or decrements it. Two *distinct* Intents (different nonces) from the same agent
  evaluated against the same snapshot can each pass and together exceed the
  round allocation. The caller must make admission atomic — reserve/decrement
  budget in the same transaction as the decision (e.g. `UPDATE … SET remaining =
  remaining - $size WHERE remaining >= $size`) or hold a per-(agent,round) lock
  around snapshot→decide→commit. `policy.spend_cap` (config) is **not** an
  enforced absolute backstop today — only `remaining_budget` gates spend. The
  `spend_cap` field is logged in `policy_events.detail_json` for audit context
  only; it does not gate any decision.
- **HALT freshness is the caller's job.** `killSwitch`/`drawdown` are read from
  the snapshot taken *before* `runReferee`'s async re-validation. To avoid an
  in-flight Intent slipping past a kill switch flipped mid-evaluation, gate
  *execution* (boundary B2) on a fresh kill-switch read, not just on the
  snapshotted decision.
- **Kill-switch default must be explicit.** `getKillSwitch` returns `null` until
  the singleton row is first written; the caller must map `null` to a
  *deliberate* `active:false` (fail-open default), not an accidental `?? false`.
- **Replay defense is not in `evaluate`.** Anti-replay belongs to P0.3/P0.2
  (nonce uniqueness). `runReferee` only re-reads via the optional `isNonceUsed`
  and performs no atomic reserve, so the caller (or a durable unique constraint)
  must enforce single-use nonces.
