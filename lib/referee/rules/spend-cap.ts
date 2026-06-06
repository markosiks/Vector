import { compareDecimal } from '@/lib/intent/canonical';
import { isTradeAction } from '@/lib/intent/types';

import type { Rule } from '../types';
import { clipNumericField } from './_shared';

/**
 * Rule — Spend cap (per-round budget), split into a blocking reject and a
 * clipping reduction so each lands in the correct evaluation phase.
 *
 * The binding budget is the agent's remaining allocation this round
 * (`state.agent.remaining_budget`), so "round exposure would exceed allocation"
 * reduces to "this trade's `size` exceeds the remaining budget". Comparisons are
 * exact decimal-string comparisons — never floats. Both rules apply only to
 * exposure-creating trades (`open`, `modify`) and report `rule_fired: 'spend_cap'`.
 */

const detailBase = (
  intent: Parameters<Rule>[0],
  state: Parameters<Rule>[1],
  config: Parameters<Rule>[2],
): Record<string, unknown> => ({
  size: intent.size,
  remaining_budget: state.agent.remaining_budget,
  allocation: state.agent.allocation,
  spend_cap: config.spend_cap,
});

/**
 * Blocking branch: when no budget remains there is nothing to clip down to, so
 * the trade is rejected outright (`soft`). Runs in the blocking phase so a
 * zero-budget agent can never have an oversized trade clipped and let through.
 */
export const spendCapRejectRule: Rule = (intent, state, config) => {
  if (!isTradeAction(intent.action)) return null;
  if (compareDecimal(state.agent.remaining_budget, 0) > 0) return null;
  return {
    decision: 'REJECT',
    severity: 'soft',
    rule_fired: 'spend_cap',
    detail: { ...detailBase(intent, state, config), reason: 'no_remaining_budget' },
  };
};

/**
 * Clipping branch: when budget remains but the trade's `size` exceeds it, the
 * size is reduced to the remaining budget (`soft`). Runs in the clipping phase
 * alongside the size/leverage caps so every breached cap is clamped together.
 */
export const spendCapClipRule: Rule = (intent, state, config) => {
  if (!isTradeAction(intent.action)) return null;
  const remaining = state.agent.remaining_budget;
  if (compareDecimal(remaining, 0) <= 0) return null; // handled by spendCapRejectRule
  if (compareDecimal(intent.size, remaining) <= 0) return null;
  return {
    decision: 'CLIP',
    severity: 'soft',
    rule_fired: 'spend_cap',
    detail: { ...detailBase(intent, state, config), reason: 'exposure_exceeds_budget' },
    modified_intent: clipNumericField(intent, 'size', remaining),
    clipped: true,
  };
};
