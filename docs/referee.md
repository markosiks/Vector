# Referee / Firewall (P1.1)

The referee is Vector's **bounded-execution gate** (architecture §6.3): the single
path from a validated, signed Intent to the execution rail (boundary B2). It takes
a typed Intent — never a prompt — evaluates it against a **fixed, ordered** rule
set, and reduces it to one of four decisions, emitting one `policy_event` per
decision.

`evaluate(intent, state, config)` is a **pure, deterministic** function: the same
inputs always yield the same decision and the same `policy_event`. Scoring,
routing, and execution live elsewhere — the referee only judges.

## Ordered rules — first failing rule decides

Rules run in this exact order; the first one that fires decides the outcome and
later rules never run. **Order is the single source of truth** (see
`lib/referee/rules/index.ts`).

| # | Rule (`rule_fired`)                | Applies to            | Condition                                              | Decision | Severity |
|---|------------------------------------|-----------------------|-------------------------------------------------------|----------|----------|
| 1 | `kill_switch`                      | all                   | global kill switch active                             | HALT     | halt     |
| 2 | `market_whitelist`                 | open, modify, close   | `market` not in `market_whitelist` (exact match)      | REJECT   | hard     |
| 3 | `fresh_wallet_transfer_block`      | transfer              | destination not on address whitelist (or missing)     | REJECT   | hard     |
| 4 | `size_cap`                         | open, modify          | `size > max_trade_size`                               | CLIP     | soft     |
| 5 | `spend_cap`                        | open, modify          | `remaining_budget == 0`                               | REJECT   | soft     |
|   |                                    |                       | `size > remaining_budget`                            | CLIP     | soft     |
| 6 | `leverage_cap`                     | open, modify          | `leverage > max_leverage`                            | CLIP     | soft     |
| 7 | `drawdown_breaker`                 | all                   | `drawdown >= dd_breaker`                             | HALT     | halt     |
| — | `allow`                            | all                   | no rule fired                                         | ALLOW    | none     |
| — | `pre_validation`                   | all (in `runReferee`) | P0.3 structural re-validation failed                  | REJECT   | none     |

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
- **The drawdown breaker uses `>=`** (rule 7): a circuit breaker trips on
  *reaching* its limit — `drawdown == dd_breaker` halts. This is the fail-safe
  choice for a risk control, and is deliberately asymmetric to the caps.
- **First failing rule decides**: rules are not chained. A `size_cap` CLIP
  returns immediately even if the (now smaller) trade would still breach the
  budget — the next submission is re-judged from the top.

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
