# Scoring engine (P1.2 — `AgentScore ∈ [0, 100]`)

Source of truth: architecture.txt §6.1. This document pins the formulas, the
meaning and range of every constant, the anti-Sybil / anti-wash rationale, the
floor-crash invariant, and the `components_json` contract.

The implementation is a pure function, `lib/scoring/score.ts#score`, plus a thin
persistence layer, `lib/scoring/record.ts`. `score()` performs no I/O, reads no
clock, and uses no randomness, so a fixed input yields a **bit-identical** result
on every run (the §6.5 determinism mandate). The stored `raw_r`/`score_r` are
quantized to their `numeric` column scale before persistence, so a row is exactly
reproducible (see [Determinism](#determinism-and-fixed-scale-output)).

## Inputs (`ScoreInputs`) — per agent, per round

| Field     | Meaning                                                                                 | Domain            |
| --------- | --------------------------------------------------------------------------------------- | ----------------- |
| `pnl_r`   | Round PnL, realized + marked.                                                           | finite            |
| `car_r`   | Capital-at-risk: time-weighted `|notional|`. **The only exposure signal.**              | finite, `>= 0`    |
| `soft`    | Count of `soft` policy violations.                                                      | integer `>= 0`    |
| `hard`    | Count of `hard` policy violations.                                                      | integer `>= 0`    |
| `halt`    | Count of `halt` policy violations.                                                      | integer `>= 0`    |
| `dd_r`    | Max drawdown as a fraction of allocation.                                               | finite, `>= 0`    |
| `drain_r` | A confirmed drain attempt — referee rule #3 (`fresh_wallet_transfer_block`) fired.      | boolean           |

`clean_r` (§6.1) is **derived**, not passed: `clean_r = (hard === 0)`. Deriving it
from the violation counts removes a whole class of contradictory input (a caller
asserting `clean_r = true` alongside `hard > 0`); every input then maps to a
single deterministic outcome — a value or a thrown `RangeError`.

Neither trade count nor traded volume is an input. Capital exposure enters
**only** through `car_r`. This is the structural root of the anti-wash property.

Invalid inputs (`NaN`/`±∞`, negative `car_r`/`dd_r`, fractional or negative
counts, non-finite `prevScore`) throw `RangeError` — they are never normalized
into a silent score.

## Formulas (§6.1, steps 1–7)

```
roc_r   = pnl_r / max(car_r, ε)
perf_r  = clamp(0.5 + k_perf·tanh(roc_r / s_roc), 0, 1)          # bounded performance, [0,1]
w_r     = car_r / (car_r + c_floor)                              # capital risk-weight, [0,1)
policy_r   = (clean_r ? b_clean : 0) − p_soft·#soft − p_hard·#hard − p_halt·#halt   # points
dd_pen_r   = p_dd · clamp(dd_r − dd_tol, 0, 1)                   # points
raw_r   = clamp(100·perf_r·w_r + policy_r − dd_pen_r, 0, 100)    # round score, [0,100]
Score_r = α·raw_r + (1−α)·Score_{r−1}                           # EWMA over history
# Floor-crash (step 7): only if #halt > 0 OR drain_r
Score_r ← min(Score_r, crash_cap)
```

A brand-new agent seeds the EWMA with `Score_0 = score_0` (a low prior — trust is
earned, never granted), not the DB default of 0.

### Scale reconciliation (important)

§6.1 writes the round score as `raw_r = 100·clamp(perf·w + policy − dd, 0, 1)`.
But every penalty/bonus constant in `CONFIG.scoring` is on a **0–100 point**
scale (`b_clean=5`, `p_soft=3`, `p_hard=40`, `p_halt=60`, `p_dd=20`), as are
`score_0=20`, `crash_cap=7`, and the router's `s_min=30`. Mixing a `[0,1]` term
(`perf·w`) with point-scale penalties inside a `[0,1]` clamp is only coherent if
the penalties are read as points, i.e.

```
raw_r = clamp(100·perf·w + policy_pts − dd_pts, 0, 100)
      ≡ 100·clamp(perf·w + policy_pts/100 − dd_pts/100, 0, 1)
```

which is the implemented form. This is the only reading consistent with §6.1's
own note that an ordinary (non-drain) `hard` is a **dominant penalty in
`policy_r`** — *not* a forced collapse. Under the literal `[0,1]` clamp a single
`hard` (−40) would drive `raw_r` to 0, i.e. *below* `crash_cap = 7`, erasing the
deliberate distinction between an ordinary `hard` and a floor-crash
(`halt`/drain). The point-scale form keeps a `hard` as a large dominating
subtraction while reserving collapse-to-`crash_cap` for `halt`/drain, and it is
what lets the anti-Sybil weight `w_r` actually bite (a clean low-capital agent
does not saturate to 100).

## Constants (`CONFIG.scoring`, §6.1)

| Constant    | Default | Meaning / range                                                              |
| ----------- | ------- | ---------------------------------------------------------------------------- |
| `k_perf`    | 0.5     | Performance sensitivity; with `tanh`, keeps `perf_r ∈ [0, 1]`.               |
| `s_roc`     | 0.05    | Expected per-round RoC scale inside `tanh(roc/s_roc)`.                        |
| `c_floor`   | 1000    | Capital floor in `w_r`; concavity here is the anti-Sybil lever.              |
| `b_clean`   | 5       | Bonus (pts) for a clean round (zero `hard`).                                 |
| `p_soft`    | 3       | Penalty (pts) per `soft`.                                                     |
| `p_hard`    | 40      | Penalty (pts) per `hard` — dominates positive performance.                   |
| `p_halt`    | 60      | Penalty (pts) per `halt`.                                                     |
| `p_dd`      | 20      | Drawdown penalty coefficient (pts).                                          |
| `dd_tol`    | 0.15    | Drawdown tolerance band before `dd_pen_r` applies.                           |
| `epsilon`   | 1e-9    | `~0` denominator guard in `roc_r`.                                           |
| `alpha`     | 0.4     | EWMA weight on the current round; `∈ (0, 1)`.                                |
| `score_0`   | 20      | Low prior for a new agent.                                                   |
| `crash_cap` | 7       | Floor-crash ceiling on `halt`/drain.                                         |

## Floor-crash invariant

> `#halt > 0 ∨ drain_r ⇒ Score_r ≤ crash_cap`, applied **after** the EWMA, so a
> catastrophe collapses reputation regardless of a strong prior or a strong raw
> round. `min()` means it only lowers — a score already below `crash_cap` is not
> raised to it.

An ordinary (non-drain, no-halt) `hard` does **not** floor-crash. It applies a
large dominating penalty in `policy_r` (−`p_hard`) and nothing more. This keeps a
recoverable bad round (e.g. a whitelist REJECT) distinct from an unrecoverable
catastrophe (kill-switch `halt` or a confirmed fund drain).

## Anti-Sybil / anti-wash

- **Anti-Sybil.** `w_r = car_r / (car_r + c_floor)` is increasing in capital, so
  splitting the same capital across `N` identities gives each clone a strictly
  smaller `w_r` — hence a strictly lower score — than the consolidated honest
  agent. No fragment can outrank the whole. (The router's `s_min` eligibility and
  softmax over scores, §6.2, build on this: fragments rank lower and dilute.)
- **Anti-wash.** Trade count and volume are not inputs. A farmer churning
  micro-trades at the same net `car_r`/`pnl_r` produces an *identical* score —
  there is nowhere for activity to inflate it. At `~0` RoC, `perf_r = 0.5`, so the
  performance term is capped well below a genuine earner, and the low `score_0`
  prior plus EWMA blunt any single-round spike.

## `components_json` contract

Each `scores` row stores the explainability breakdown under **fixed keys**
`{ perf, w, policy, dd }` (this set is a contract; P2.3 attestations and P3.2 UI
read exactly these):

| Key      | Value                                            |
| -------- | ------------------------------------------------ |
| `perf`   | `perf_r ∈ [0, 1]`                                |
| `w`      | `w_r ∈ [0, 1)`                                    |
| `policy` | `policy_r` in points (bonus minus penalties)     |
| `dd`     | `dd_pen_r` in points (`>= 0`)                     |

## Persistence (`recordScore`)

`recordScore` is the **only** writer of `agents.score_current`. Per round it:

1. resolves `Score_{r−1}` (the latest persisted `score_r`, or `score_0`);
2. computes the score;
3. inserts the `scores` row (`raw_r`, `score_r`, `components_json`);
4. updates `agents.score_current` and `agents.status`.

**Gating.** A floor-crash, or a new score below `s_min`, moves the agent to
`gated`; otherwise to `active`. The status transition is computed in SQL so the
read-modify-write is atomic, and an operator-`halted` agent is never changed by
the scorer (un-halting is an operator action). The score insert is
`ON CONFLICT (agent_id, round_id) DO NOTHING`: a replay re-reads the immutable
persisted row and **still converges the agent gate from it**, so a crash that
failed to gate on a partial failure is healed on retry instead of left
fail-open. The gate is derived from the persisted `score_r` (source of truth).

**Concurrency precondition (for the P1.4 settlement caller).** `recordScore` is
a read-modify-write (prior → score → gate). A caller running concurrent rounds
for the same agent must pass a single transaction-bound client and serialize the
agent (`SELECT … FOR UPDATE` on `agents`) so the EWMA prior cannot be read stale.
Passing the shared pool is unsafe for that case. P1.2 ships no such caller.

## Determinism and fixed-scale output

The score math is real-valued (`tanh`, EWMA), computed in IEEE-754 double, which
is deterministic on a fixed engine (bun/V8). The **stored** values are quantized
to their column scale — `raw_r` to 8 fraction digits (`numeric(20,8)`), `score_r`
to 3 (`numeric(6,3)`) — via `toFixed`, yielding the exact, reproducible decimal
string the driver binds. `components` are rounded to 8 dp so the JSON carries no
float drift. The golden table (`tests/fixtures/scoring-golden.json`, checked by
`tests/unit/scoring.golden.test.ts`) pins these exact outputs; regenerate it
intentionally and review the diff — never silently re-bless.

`numeric` columns remain exact end to end (money/score are bound as strings,
never round-tripped through a float on write/read); the float arithmetic lives
only inside the score computation, which §6.1 defines in real numbers.

Cross-engine note: `Math.tanh` (and transcendentals generally) are not required
by ECMAScript to be correctly rounded, so bit-identical output is guaranteed
only within a fixed bun/V8 build, not across platforms. The `toFixed`
quantization absorbs sub-ulp noise for effectively all values; pin the runtime
for any environment that produces or re-verifies attested scores (§7.2).

## Open security notes (owner decisions, not bugs)

These are design tensions surfaced by the P1.2 security audit. They are **not**
defects in the current phase and are intentionally left for an owner call rather
than changed unilaterally:

- **Clamp saturation hides soft penalties for high-capital agents.** The terminal
  `clamp(100·perf·w + policy − dd, 0, 100)` lets a soft penalty be absorbed when
  the positive term already exceeds 100, so a whale can commit the first soft
  violation "for free" in the *scalar* score (the breakdown still records it).
  Fix only if penalties should always bite: clamp the positive term to 100 first,
  then subtract penalties. Changes scored values — couple with the §6.1
  `[0,1]`-clamp vs point-scale decision and regenerate the golden table.
- **Floor-crash is transient.** A `halt`/drain caps the crash round only; EWMA
  mean-reverts above `s_min` in ~1–3 strong rounds. This is only safe if the §6.2
  router strictly excludes `gated` agents (no self-funded `car_r`). If a sticky
  cooldown is wanted, persist crash state on the agent — out of scope for P1.2.
- **No escalation for sustained ordinary `hard` violations.** A capitalized agent
  can trip a (non-drain) `hard` rule every round and stay eligible; penalties are
  per-round, memoryless. Add a rolling-window hard counter if escalation is
  desired.
- **`s_min` boundary (already consistent — not open):** the scorer gates on
  `score < s_min`; the router's `isEligible` (`derive.ts`, §6.2 step 1) uses
  `score >= s_min`. These are exact complements, so a score of exactly `s_min`
  is both un-gated and eligible. Keep them in lockstep if either changes.
- **Append-only `scores`:** immutability is app-layer only today (no
  `UPDATE`/`DELETE` path). A DB-level guarantee belongs with the deferred
  `policy_events` append-only hardening item; include `scores` when that lands.
