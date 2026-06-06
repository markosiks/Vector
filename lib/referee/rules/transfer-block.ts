import type { Rule } from '../types';
import { isWhitelistedAddress } from './_shared';

/**
 * Rule 3 — Fresh-wallet / transfer block. **The demo's load-bearing rule.**
 *
 * A `transfer` (the only fund-moving action, §8.2; "withdraw" is a descriptive
 * synonym) to a destination that is not on the address whitelist is rejected
 * hard. The whitelist is an explicit override: a whitelisted address is allowed
 * even if it looks fresh; any other destination — including one with no
 * `target_address` at all — is treated as a drain and blocked.
 *
 * Wallet freshness (age / zero-history) is computed for the audit rationale and
 * to feed `drain_r` in P1.2, but it never softens the decision: a
 * non-whitelisted transfer is **always** `REJECT` + `hard`. This is the
 * critical invariant — no `transfer` to a non-whitelisted address may ever be
 * ALLOWed or CLIPped.
 */
export const transferBlockRule: Rule = (intent, state, config) => {
  if (intent.action !== 'transfer') return null;

  const target = intent.target_address;
  const { whitelist, max_age_seconds, require_zero_history } = config.fresh_wallet_criteria;

  if (target !== undefined && isWhitelistedAddress(target, whitelist)) return null;

  const info = state.destination;
  const ageFresh = info?.age_seconds !== undefined && info.age_seconds < max_age_seconds;
  const historyFresh = require_zero_history && info?.has_history === false;
  // Unknown destination metadata is treated as fresh (fail-closed).
  const isFresh = info === undefined || ageFresh || historyFresh;

  return {
    decision: 'REJECT',
    severity: 'hard',
    rule_fired: 'fresh_wallet_transfer_block',
    detail: {
      reason: target === undefined ? 'missing_target_address' : 'non_whitelisted_destination',
      target_address: target ?? null,
      is_fresh: isFresh,
      ...(info?.age_seconds !== undefined ? { age_seconds: info.age_seconds } : {}),
      ...(info?.has_history !== undefined ? { has_history: info.has_history } : {}),
    },
  };
};
