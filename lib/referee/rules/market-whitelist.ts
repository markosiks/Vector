import type { Rule } from '../types';

/**
 * Rule 2 — Market / contract whitelist.
 *
 * An Intent that targets a market outside the allow-list is rejected hard.
 * Applies to every action that names a market (`open`, `modify`, `close`);
 * `transfer` carries no market and is governed by the transfer-block rule.
 *
 * Market symbols are matched exactly (not case-folded): a differently-cased
 * variant such as `btc-perp` is simply not whitelisted and is rejected, so
 * casing cannot be used to slip a market past the allow-list.
 */
export const marketWhitelistRule: Rule = (intent, _state, config) => {
  if (intent.action === 'transfer') return null;
  if (config.market_whitelist.includes(intent.market)) return null;
  return {
    decision: 'REJECT',
    severity: 'hard',
    rule_fired: 'market_whitelist',
    detail: { market: intent.market, whitelist: [...config.market_whitelist] },
  };
};
