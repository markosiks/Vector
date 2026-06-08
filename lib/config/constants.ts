import { configSchema, type VectorConfig } from './constants.schema';
import { deepFreeze, type DeepReadonly } from '../utils/deep-freeze';

/**
 * Vector's single source of truth for every scoring, routing, timing, signal,
 * policy, capital and chain constant.
 *
 * This is the **only** place these values may be defined. Every consumer imports
 * {@link CONFIG}; nothing else in the codebase hardcodes a scoring weight, a
 * poll interval, a whitelist entry, a signal endpoint/TTL, or the chain id. That
 * invariant is what makes the 90-second demo deterministic and explainable to
 * judges on one screen (architecture.txt §6.1 Determinism note).
 *
 * Values are validated by {@link configSchema} at module load, so an invalid
 * constant (negative penalty, `alpha` outside `(0, 1)`, `NaN` tick rate, …)
 * crashes startup instead of silently corrupting a run. The validated object is
 * then deeply frozen, so any mutation attempt throws.
 *
 * Where the spec gives a range or example, the chosen default is recorded in
 * `docs/config.md` with its §ARCH reference. None of these are secrets — the
 * config is safe to read on both server and client. Secrets (DB string, RPC
 * URL, API keys) live in env (`lib/config/env.ts`), never here.
 */
const RAW_CONFIG = {
  // ── Scoring (§6.1) ──────────────────────────────────────────────────────
  scoring: {
    k_perf: 0.5,
    s_roc: 0.05,
    c_floor: 1_000,
    b_clean: 5,
    p_soft: 3,
    p_hard: 40,
    p_halt: 60,
    p_dd: 20,
    dd_tol: 0.15,
    epsilon: 1e-9,
    alpha: 0.4,
    score_0: 20,
    crash_cap: 7,
  },
  // ── Capital router (§6.2) ───────────────────────────────────────────────
  router: {
    s_min: 30,
    tau: 12,
    h: 0.05,
    max_step: 0.25,
    cooldown_ticks: 3,
  },
  // ── Ticks & polling (§7.3) ──────────────────────────────────────────────
  timing: {
    tick_rate_ms: 2_000,
    ticks_per_round: 5,
    ui_poll_ms: 1_500,
  },
  // ── Nansen smart-money signal (P2.2) ────────────────────────────────────
  nansen: {
    poll_every_n_ticks: 10,
    endpoint: 'https://api.nansen.ai',
    cache_ttl_ms: 60_000,
  },
  // ── Elfa social signal (P3.1) ───────────────────────────────────────────
  elfa: {
    mode: 'mock',
    endpoint: 'https://api.elfa.ai',
    cache_ttl_ms: 60_000,
    poll_every_n_ticks: 15,
  },
  // ── Bounded-execution policy (§6.3) ─────────────────────────────────────
  policy: {
    max_trade_size: 10_000,
    max_leverage: 5,
    dd_breaker: 0.3,
    spend_cap: 50_000,
    market_whitelist: ['BTC-PERP', 'ETH-PERP'],
    fresh_wallet_criteria: {
      max_age_seconds: 86_400,
      require_zero_history: true,
      whitelist: [],
    },
  },
  // ── Labeled-testnet capital (V4) ────────────────────────────────────────
  capital: {
    pool_size: 1_000_000,
    capital_unit_label: 'tMNT',
  },
  // ── Mantle chain references (P2.3 / P1.7) ───────────────────────────────
  chain: {
    // Mantle Sepolia testnet.
    mantle_testnet_chain_id: 5003,
    mantle_explorer_base_url: 'https://explorer.sepolia.mantle.xyz',
    // Canonical ERC-8004 singletons on Mantle Sepolia (VERIFY V2, P1.7).
    // Source: github.com/erc-8004/erc-8004-contracts (master) + on-chain
    // confirmation (getIdentityRegistry() cross-check). See
    // docs/erc8004-registry.md. These are not secrets.
    reputation_registry_address: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    identity_registry_address: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  },
};

/**
 * The validated, deeply-immutable seeded config. Importing this module is what
 * proves the config "loaded": if validation fails, the import throws.
 */
export const CONFIG: DeepReadonly<VectorConfig> = deepFreeze(configSchema.parse(RAW_CONFIG));

/** Re-exported for consumers that want the structural type without the value. */
export type { VectorConfig } from './constants.schema';
