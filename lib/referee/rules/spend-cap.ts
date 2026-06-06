import { compareDecimal } from '@/lib/intent/canonical';
import { isTradeAction } from '@/lib/intent/types';

import type { Rule } from '../types';
import { clipNumericField } from './_shared';

/**
 * Rule 5 — Spend cap (per-round budget).
 *
 * The binding budget is the agent's remaining allocation this round
 * (`state.agent.remaining_budget`), so "round exposure would exceed allocation"
 * reduces to "this trade's `size` exceeds the remaining budget":
 *
 *   - remaining budget is zero        → `REJECT` (`soft`): nothing left to spend.
 *   - `size` exceeds remaining budget → `CLIP` (`soft`): size reduced to the
 *                                        remaining budget.
 *   - otherwise                       → pass.
 *
 * Applies to exposure-creating trades (`open`, `modify`). Comparisons are exact
 * decimal-string comparisons — never floats.
 */
export const spendCapRule: Rule = (intent, state, config) => {
  if (!isTradeAction(intent.action)) return null;

  const remaining = state.agent.remaining_budget;
  const detailBase = {
    size: intent.size,
    remaining_budget: remaining,
    allocation: state.agent.allocation,
    spend_cap: config.spend_cap,
  };

  if (compareDecimal(remaining, 0) <= 0) {
    return {
      decision: 'REJECT',
      severity: 'soft',
      rule_fired: 'spend_cap',
      detail: { ...detailBase, reason: 'no_remaining_budget' },
    };
  }

  if (compareDecimal(intent.size, remaining) <= 0) return null;

  return {
    decision: 'CLIP',
    severity: 'soft',
    rule_fired: 'spend_cap',
    detail: { ...detailBase, reason: 'exposure_exceeds_budget' },
    modified_intent: clipNumericField(intent, 'size', remaining),
    clipped: true,
  };
};
