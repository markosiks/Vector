# Seeded config — the single source of truth

Every scoring, routing, timing, signal, policy, capital and chain constant lives
in **one** file: [`lib/config/constants.ts`](../lib/config/constants.ts). It is
validated by [`constants.schema.ts`](../lib/config/constants.schema.ts) at module
load and then deeply frozen, so:

- an invalid value (negative penalty, `alpha ∉ (0,1)`, `NaN`/`Infinity`, empty
  whitelist, …) **crashes startup** instead of silently corrupting a run, and
- any mutation attempt at runtime **throws**.

**Single-source rule:** none of these values may be hardcoded anywhere else.
Consumers import `CONFIG` (often via [`derive.ts`](../lib/config/derive.ts)).
This is enforced by `tests/e2e/single-source.e2e.test.ts`, which fails if a
distinctive constant value appears outside `constants.ts`.

> These constants are **not secrets** — the config is safe on server and client.
> Secrets (DB string, RPC URL, API keys) live in env, never here. See
> [`env.md`](./env.md).

Where the spec gives a range or example, the chosen default is recorded below
with its `architecture.txt` reference (§).

## Scoring — §6.1

| Name        | Type   | Default | Meaning |
| ----------- | ------ | ------- | ------- |
| `k_perf`    | number | `0.5`   | Sensitivity of `perf_r = clamp(0.5 + k_perf·tanh(roc_r/s_roc), 0, 1)`. |
| `s_roc`     | number | `0.05`  | Scale of expected per-round RoC inside the `tanh`. |
| `c_floor`   | number | `1000`  | Capital floor in the risk weight `w_r = car_r/(car_r + c_floor)`. |
| `b_clean`   | number | `5`     | Bonus for a fully clean round. |
| `p_soft`    | number | `3`     | Penalty per `soft` violation. |
| `p_hard`    | number | `40`    | Penalty per `hard` violation — **dominates** `b_clean`/typical perf. |
| `p_halt`    | number | `60`    | Penalty per `halt` violation. |
| `p_dd`      | number | `20`    | Drawdown penalty coefficient. |
| `dd_tol`    | number | `0.15`  | Drawdown tolerance band before `dd_penalty_r` applies. |
| `epsilon`   | number | `1e-9`  | Division guard against `~0` denominators in `roc_r`. |
| `alpha`     | number | `0.4`   | EWMA weight on the current round; must be in `(0,1)`. |
| `score_0`   | number | `20`    | Low starting prior for a new agent. |
| `crash_cap` | number | `7`     | Floor-crash cap on `#halt>0` or a confirmed drain attempt. |

The penalty asymmetry (`p_hard ≫ b_clean`) is what makes reputation **collapse**
when the referee blocks a theft in the demo.

## Capital router — §6.2

| Name             | Type   | Default | Meaning |
| ---------------- | ------ | ------- | ------- |
| `s_min`          | number | `30`    | Minimum score to receive capital (eligibility gate). |
| `tau`            | number | `12`    | Softmax temperature; lower = sharper concentration on the leader. |
| `h`              | number | `0.05`  | Hysteresis band: ignore target-weight deltas below this fraction. |
| `max_step`       | number | `0.25`  | Max fraction of the pool moved per reallocation. |
| `cooldown_ticks` | int    | `3`     | Cooldown (ticks) after a large reallocation. |

## Ticks & polling — §7.3

| Name             | Type | Default | Meaning |
| ---------------- | ---- | ------- | ------- |
| `tick_rate_ms`   | int  | `2000`  | Replay-engine tick interval (ms). |
| `ticks_per_round`| int  | `5`     | Ticks per round before scores settle. |
| `ui_poll_ms`     | int  | `1500`  | UI SWR poll interval (ms). |

## Nansen signal — P2.2 / §7.6

| Name                 | Type   | Default                   | Meaning |
| -------------------- | ------ | ------------------------- | ------- |
| `poll_every_n_ticks` | int    | `10`                      | Slow cadence for the Nansen fetch. |
| `endpoint`           | string | `https://api.nansen.ai`   | API base URL (non-secret). |
| `cache_ttl_ms`       | int    | `60000`                   | Cache TTL (ms). |

## Elfa signal — P3.1

| Name                 | Type           | Default                | Meaning |
| -------------------- | -------------- | ---------------------- | ------- |
| `mode`               | `real`\|`mock` | `mock`                 | `real` hits the live API; `mock` replays a fixture. |
| `endpoint`           | string         | `https://api.elfa.ai`  | API base URL (non-secret). |
| `cache_ttl_ms`       | int            | `60000`                | Cache TTL (ms). |
| `poll_every_n_ticks` | int            | `15`                   | Slow cadence for the Elfa fetch. |

## Policy (bounded execution) — §6.3

| Name                    | Type     | Default                 | Meaning |
| ----------------------- | -------- | ----------------------- | ------- |
| `max_trade_size`        | number   | `10000`                 | Max notional of a single trade Intent. |
| `max_leverage`          | number   | `5`                     | Max leverage permitted by the referee. |
| `dd_breaker`            | number   | `0.30`                  | Drawdown circuit-breaker threshold. |
| `spend_cap`             | number   | `50000`                 | **Fallback** per-round ceiling. The binding budget is per-round in `capital_allocations`, not this default. |
| `market_whitelist`      | string[] | `["BTC-PERP","ETH-PERP"]` | Allowed markets/contracts. Refine for the chosen rail in P1. |
| `fresh_wallet_criteria` | object   | see below               | Inputs to referee rule #3 (drain-to-fresh-wallet). |

`fresh_wallet_criteria`: `{ max_age_seconds: 86400, require_zero_history: true, whitelist: [] }`.

## Capital (labeled testnet) — V4

| Name                 | Type   | Default     | Meaning |
| -------------------- | ------ | ----------- | ------- |
| `pool_size`          | number | `1000000`   | Fixed pool size (conserved on reallocation). |
| `capital_unit_label` | string | `tMNT`      | Human-facing testnet capital label. |

## Chain references — P2.3

| Name                       | Type   | Default                                   | Meaning |
| -------------------------- | ------ | ----------------------------------------- | ------- |
| `mantle_testnet_chain_id`  | int    | `5003`                                    | Mantle Sepolia testnet chain id. |
| `mantle_explorer_base_url` | string | `https://explorer.sepolia.mantle.xyz`     | Explorer base for tx/address links. |

> Defaults marked from the spec as examples (e.g., `alpha ∈ 0.3–0.5`,
> `crash_cap ∈ 5–10`, `s_min ≈ 30`, `tick ≈ 1–3 s`, `ui_poll ≈ 1–2 s`) are
> tuned here for the 90-second demo arc and can be re-tuned in this one file.
