import type { Rule } from '../types';

/**
 * Rule 1 — Global kill switch / HALT.
 *
 * The highest-priority gate: when the operator kill switch is active, every
 * Intent halts regardless of its contents. Sits first so nothing can slip past
 * during an incident.
 */
export const killSwitchRule: Rule = (_intent, state) => {
  if (!state.killSwitch.active) return null;
  return {
    decision: 'HALT',
    severity: 'halt',
    rule_fired: 'kill_switch',
    detail: { reason: state.killSwitch.reason ?? 'kill switch active' },
  };
};
