import { isAddress } from 'viem';
import { z } from 'zod';

/**
 * Validation schema for the seeded constant config.
 *
 * The schema is the runtime guard that makes the single source of truth
 * trustworthy: every value is range-checked at module load, so a typo such as a
 * negative penalty, an `alpha` outside `(0, 1)`, or a `NaN`/`Infinity` tick rate
 * fails loudly at startup instead of silently corrupting the demo.
 *
 * Reference: architecture.txt §6.1 (scoring), §6.2 (routing), §7.3 (polling).
 */

/** A finite number that is strictly greater than zero. */
const positive = z.number().finite().positive();

/** A finite number that is zero or greater. */
const nonNegative = z.number().finite().nonnegative();

/** A finite number in the closed interval `[0, 1]`. */
const unitInterval = z.number().finite().min(0).max(1);

/** A finite number in the open interval `(0, 1)`. */
const openUnitInterval = z.number().finite().gt(0).lt(1);

/** A strictly positive integer (used for tick / cadence counters). */
const positiveInt = z.number().int().positive();

/** An `http(s)` URL string. */
const httpUrl = z.string().url().startsWith('http');

/**
 * A checksummed EVM address (`0x` + 40 hex). Validated with viem's `isAddress`
 * in strict mode so a mistyped or wrong-checksum literal fails at module load
 * rather than silently pointing the app at the wrong contract.
 */
const evmAddress = z
  .string()
  .refine((value) => isAddress(value, { strict: true }), {
    message: 'must be a checksummed 0x-prefixed 20-byte EVM address',
  });

/**
 * Scoring constants — §6.1. Penalties are intentionally asymmetric so a single
 * `hard` violation dominates any positive performance and reputation collapses.
 */
export const scoringSchema = z.object({
  /** Sensitivity of the bounded performance term `perf_r`. */
  k_perf: positive,
  /** Scale of expected per-round RoC magnitude inside `tanh(roc_r / s_roc)`. */
  s_roc: positive,
  /** Capital floor in the risk weight `w_r = car_r / (car_r + c_floor)`. */
  c_floor: positive,
  /** Bonus awarded for a fully clean round. */
  b_clean: nonNegative,
  /** Penalty per `soft` violation. */
  p_soft: nonNegative,
  /** Penalty per `hard` violation — must dominate `b_clean` and typical perf. */
  p_hard: nonNegative,
  /** Penalty per `halt` violation. */
  p_halt: nonNegative,
  /** Drawdown penalty coefficient. */
  p_dd: nonNegative,
  /** Drawdown tolerance band before `dd_penalty_r` applies. */
  dd_tol: unitInterval,
  /** Division guard against `~0` denominators in `roc_r`. */
  epsilon: positive,
  /** EWMA weight on the current round in `Score_r`; must be in `(0, 1)`. */
  alpha: openUnitInterval,
  /** Low starting prior for a new agent — trust is earned, never granted. */
  score_0: nonNegative,
  /** Floor-crash cap applied on `#halt > 0` or a confirmed drain attempt. */
  crash_cap: nonNegative,
});

/** Capital-router constants — §6.2 (eligibility, softmax, hysteresis). */
export const routerSchema = z.object({
  /** Minimum score to be eligible for capital. */
  s_min: nonNegative,
  /** Softmax temperature; lower concentrates capital more sharply on the leader. */
  tau: positive,
  /** Hysteresis band: ignore target-weight deltas below this fraction. */
  h: unitInterval,
  /** Max-step rate limit: max fraction of the pool moved per reallocation. */
  max_step: unitInterval,
  /** Cooldown in ticks after a large reallocation before the next move. */
  cooldown_ticks: positiveInt,
});

/** Tick / polling cadence constants — §7.3. */
export const timingSchema = z.object({
  /** Replay-engine tick interval in milliseconds. */
  tick_rate_ms: positiveInt,
  /** Number of ticks per round before scores settle. */
  ticks_per_round: positiveInt,
  /** UI SWR poll interval in milliseconds. */
  ui_poll_ms: positiveInt,
});

/** Nansen smart-money signal config — P2.2. The API key lives in env, not here. */
export const nansenSchema = z.object({
  /** Fetch the Nansen signal once per this many ticks (slow cadence). */
  poll_every_n_ticks: positiveInt,
  /** Nansen API base URL (non-secret). */
  endpoint: httpUrl,
  /** Cache TTL for the Nansen signal in milliseconds. */
  cache_ttl_ms: positiveInt,
});

/** Elfa social-signal config — P3.1. The API key lives in env, not here. */
export const elfaSchema = z.object({
  /** `real` hits the live API; `mock` replays a fixture. */
  mode: z.enum(['real', 'mock']),
  /** Elfa API base URL (non-secret). */
  endpoint: httpUrl,
  /** Cache TTL for the Elfa signal in milliseconds. */
  cache_ttl_ms: positiveInt,
  /** Fetch the Elfa signal once per this many ticks. */
  poll_every_n_ticks: positiveInt,
});

/** Criteria the referee uses to flag a destination as a "fresh wallet" (rule #3). */
export const freshWalletCriteriaSchema = z.object({
  /** A wallet younger than this many seconds is considered fresh. */
  max_age_seconds: positiveInt,
  /** Whether a fresh wallet must also have zero prior transaction history. */
  require_zero_history: z.boolean(),
  /** Addresses explicitly allowed even if they look fresh. */
  whitelist: z.array(z.string()).readonly(),
});

/** Bounded-execution policy defaults — §6.3. */
export const policySchema = z.object({
  /** Maximum notional size of a single trade Intent. */
  max_trade_size: positive,
  /** Maximum leverage permitted by the referee. */
  max_leverage: positive,
  /** Drawdown circuit-breaker threshold (fraction). */
  dd_breaker: unitInterval,
  /** Fallback per-round spend ceiling; the binding budget is per-round in
   *  `capital_allocations`, not this default. */
  spend_cap: positive,
  /** Markets/contracts the referee allows trading against. */
  market_whitelist: z.array(z.string()).nonempty().readonly(),
  /** Inputs to referee rule #3 (drain-to-fresh-wallet detection). */
  fresh_wallet_criteria: freshWalletCriteriaSchema,
});

/** Labeled-testnet capital pool config — V4. */
export const capitalSchema = z.object({
  /** Fixed size of the labeled-testnet capital pool (conserved on reallocation). */
  pool_size: positive,
  /** Human-facing label for capital units (clearly marked as testnet). */
  capital_unit_label: z.string().min(1),
});

/** Mantle chain references used to build explorer links — P2.3. */
export const chainSchema = z.object({
  /** Mantle testnet chain id. */
  mantle_testnet_chain_id: positiveInt,
  /** Base URL of the Mantle testnet explorer (used for tx/address links). */
  mantle_explorer_base_url: httpUrl,
  /**
   * Canonical ERC-8004 Reputation Registry on Mantle testnet — the on-chain
   * anchor for per-round attestations (P1.7, §9.4/§15). Address only; the
   * operator key and RPC URL are secrets and live in env, never here.
   */
  reputation_registry_address: evmAddress,
  /**
   * Canonical ERC-8004 Identity Registry on Mantle testnet. A Reputation
   * Registry feedback `agentId` is this registry's ERC-721 tokenId, so the
   * address is recorded for provenance and cross-checks even though Identity
   * writes are ROADMAP.
   */
  identity_registry_address: evmAddress,
});

/**
 * The full seeded-config schema.
 *
 * The cross-field refinement guards invariants that span domains and would
 * otherwise fail *silently* — no per-field range check can catch them, yet a
 * plausible config edit can break a core guarantee with no startup error:
 *
 *  - `scoring.crash_cap < router.s_min` — a floor-crashed agent is capped to
 *    `crash_cap` and gated *this* round, but next round the router re-derives
 *    eligibility purely from `score_current >= s_min`. The crashed agent stays
 *    excluded next round *only because* `crash_cap < s_min`. Raise `crash_cap`
 *    to or above `s_min` and a floor-crash silently stops gating — the whole
 *    point of reputation collapse defeated.
 *  - `scoring.score_0 < router.s_min` — a new agent's starting prior must sit
 *    below the eligibility floor so "trust is earned, never granted": at or
 *    above `s_min`, a brand-new agent is funded on arrival.
 */
export const configSchema = z
  .object({
    scoring: scoringSchema,
    router: routerSchema,
    timing: timingSchema,
    nansen: nansenSchema,
    elfa: elfaSchema,
    policy: policySchema,
    capital: capitalSchema,
    chain: chainSchema,
  })
  .superRefine((cfg, ctx) => {
    if (cfg.scoring.crash_cap >= cfg.router.s_min) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scoring', 'crash_cap'],
        message: `crash_cap (${cfg.scoring.crash_cap}) must be < router.s_min (${cfg.router.s_min}) so a floor-crashed agent stays gated next round`,
      });
    }
    if (cfg.scoring.score_0 >= cfg.router.s_min) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scoring', 'score_0'],
        message: `score_0 (${cfg.scoring.score_0}) must be < router.s_min (${cfg.router.s_min}) so a new agent is not funded before trust is earned`,
      });
    }
  });

/** The validated, structurally-typed shape of the seeded config. */
export type VectorConfig = z.infer<typeof configSchema>;
