/**
 * The Byreal Perps CLI execution rail (P2.1) — the credibility layer (§3).
 *
 * `createByrealRail` builds a {@link import('@/lib/replay/rail').Rail} that
 * settles allowed Intents on the real Byreal/Hyperliquid testnet venue via the
 * `@byreal-io/byreal-perps-cli`, mapping fills/PnL onto `executions`/`outcomes`.
 * It is the sole holder of the scoped venue credentials, idempotent by
 * `intent_hash`, and degrades silently to the seeded fill on any miss — the
 * deterministic 90-second arc never depends on it. See `docs/byreal-rail.md`.
 */

export { createByrealRail, ByrealRailError, type ByrealRailDeps, type ByrealCliRunner } from './adapter';
export { loadByrealCredentials, type ByrealCredentials } from './credentials';
export { BYREAL_MARKETS, resolveByrealMarket, type ByrealMarket } from './markets';
export {
  buildSettlementCommand,
  buildAccountInfoCommand,
  buildPositionListCommand,
  ByrealCommandError,
  type ByrealCommand,
} from './command';
export { parseEnvelope, ByrealParseError, type ByrealEnvelope } from './envelope';
export {
  parseOrderResult,
  findPosition,
  buildOutcome,
  type OrderFill,
  type OpenPosition,
  type OutcomeParts,
} from './parse';
export {
  runByrealCli,
  resolveCliPath,
  buildChildEnv,
  ByrealCliTimeout,
  ByrealCliSpawnError,
  type ByrealCliResult,
  type RunByrealCliOptions,
} from './cli';
export {
  createMemoryIdempotencyStore,
  type IdempotencyStore,
} from './idempotency';
