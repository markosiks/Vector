import type { Rule } from '../types';

/**
 * Rule 1b — Per-agent operator HALT.
 *
 * The operator can HALT a single agent (`agents.status = 'halted'`, P2.4) without
 * tripping the global kill switch. When that agent is halted, every Intent it
 * submits halts here — directly after the global kill switch (rule #1) and before
 * any content rule — so a per-agent HALT cuts the agent's *execution* the same
 * way the global switch cuts everyone's. The capital side of the same HALT is the
 * router's job: `deriveRouterAgents` already gates a `halted` agent out of the
 * allocation (P1.3), so an operator HALT both freezes execution (here) and drains
 * the agent's capital (router) — the two halves of §11.1's per-agent control.
 *
 * Pure and content-independent: the decision depends only on `state.agent.halted`,
 * never on the Intent's payload, so it cannot be pre-empted by a crafted Intent.
 */
export const agentHaltRule: Rule = (_intent, state) => {
  if (!state.agent.halted) return null;
  return {
    decision: 'HALT',
    severity: 'halt',
    rule_fired: 'agent_halt',
    detail: { reason: 'agent halted by operator' },
  };
};
