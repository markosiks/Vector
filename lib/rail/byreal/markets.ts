import { CONFIG } from '@/lib/config/constants';

/**
 * The Byreal rail's market allow-list (P2.1, [CORE]).
 *
 * The referee (P1.1) is the load-bearing whitelist gate: only Intents on a
 * `CONFIG.policy.market_whitelist` market are ever ALLOWed/CLIPped, and only
 * those reach this rail. This module is the **narrower** venue mapping: it
 * translates Vector's internal market symbol (e.g. `BTC-PERP`) to the coin
 * symbol the Byreal CLI expects (e.g. `BTC`), and is a *defense-in-depth*
 * second gate — a market the rail does not know is settled on the seed fallback,
 * never shelled to the CLI with an unmapped symbol.
 *
 * Invariant (checked at load): every Byreal market is also referee-whitelisted.
 * A coin can never be reachable by the rail unless the referee already permits
 * it, so this map can only ever be a subset of the policy whitelist.
 */

/** A resolved Byreal venue market. */
export interface ByrealMarket {
  /** Vector's internal market symbol (matches the referee whitelist). */
  readonly market: string;
  /** The coin symbol passed to the Byreal CLI (`order market … <coin>`). */
  readonly coin: string;
}

/** Internal market symbol → Byreal CLI coin. Narrow on purpose ([CORE] scope). */
const BYREAL_COIN_BY_MARKET: Readonly<Record<string, string>> = {
  'BTC-PERP': 'BTC',
  'ETH-PERP': 'ETH',
};

/**
 * Fail-fast invariant: the rail map must be a subset of the referee whitelist.
 * Throwing at module load turns a future drift (someone adds a Byreal coin the
 * referee does not allow) into a startup crash instead of a silent gap where the
 * rail would shell a market the policy layer never sanctioned.
 */
const _whitelist = new Set<string>(CONFIG.policy.market_whitelist);
for (const market of Object.keys(BYREAL_COIN_BY_MARKET)) {
  if (!_whitelist.has(market)) {
    throw new Error(
      `byreal markets: '${market}' is not in CONFIG.policy.market_whitelist; ` +
        'the rail allow-list must be a subset of the referee whitelist',
    );
  }
}

/** The frozen set of markets the Byreal rail will settle on the live venue. */
export const BYREAL_MARKETS: readonly ByrealMarket[] = Object.freeze(
  Object.entries(BYREAL_COIN_BY_MARKET).map(([market, coin]) => Object.freeze({ market, coin })),
);

/**
 * Resolve an internal market symbol to its Byreal venue mapping, or `undefined`
 * when the rail does not support it. Matched exactly (not case-folded), mirroring
 * the referee's whitelist semantics so casing can never slip a market through.
 */
export function resolveByrealMarket(market: string): ByrealMarket | undefined {
  const coin = BYREAL_COIN_BY_MARKET[market];
  return coin === undefined ? undefined : { market, coin };
}
