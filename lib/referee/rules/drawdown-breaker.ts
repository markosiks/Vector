import { compareDecimal } from '@/lib/intent/canonical';

import type { Rule } from '../types';

/**
 * Rule 7 — Drawdown circuit-breaker.
 *
 * When the agent's intra-round drawdown reaches the breaker threshold
 * (`drawdown >= dd_breaker`) the agent is halted (gated out) for the round. A
 * circuit-breaker trips on *reaching* its limit — `drawdown == dd_breaker` halts
 * — which is the fail-safe choice for a risk control (contrast the size/leverage
 * caps, where the cap value itself is permitted).
 *
 * Runs last in the ordered set: an Intent that already trips an earlier rule is
 * decided there first.
 */
export const drawdownBreakerRule: Rule = (_intent, state, config) => {
  if (compareDecimal(state.agent.drawdown, config.dd_breaker) < 0) return null;
  return {
    decision: 'HALT',
    severity: 'halt',
    rule_fired: 'drawdown_breaker',
    detail: { drawdown: state.agent.drawdown, dd_breaker: config.dd_breaker },
  };
};
