import type { Intent } from '@/lib/intent/types';

import { RULES } from './rules';
import type { RefereeConfig, RefereeResult, RefereeState } from './types';

/**
 * Evaluate a validated Intent against the ordered policy rule set (§6.3).
 *
 * Pure and deterministic: identical `(intent, state, config)` always yield the
 * identical result (and therefore the identical `policy_event`). The rules run
 * in {@link RULES} order and the **first one that fires decides** — later rules
 * never run, so e.g. a size-cap CLIP returns immediately even if the trade would
 * also breach the budget. When no rule fires the Intent is allowed unchanged.
 *
 * This function performs no IO. Structural re-validation (P0.3) and persisting
 * the `policy_event` belong to {@link runReferee} in `record.ts`.
 */
export function evaluate(
  intent: Intent,
  state: RefereeState,
  config: RefereeConfig,
): RefereeResult {
  for (const rule of RULES) {
    const result = rule(intent, state, config);
    if (result !== null) return result;
  }
  return { decision: 'ALLOW', severity: 'none', rule_fired: 'allow', detail: {} };
}
