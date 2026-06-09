import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { evaluate } from '@/lib/referee/evaluate';
import { agentHaltRule } from '@/lib/referee/rules/agent-halt';
import { BLOCKING_RULES } from '@/lib/referee/rules';
import { cleanState, openIntent, transferIntent } from '@/tests/fixtures/referee-fixtures';

/**
 * Unit: the per-agent HALT rule (P2.4, §11.1). A `halted` agent must HALT at
 * rule #1b — after the global kill switch, before any content rule — so an
 * operator HALT cuts the agent's execution regardless of the Intent's payload.
 * The ordering is asserted against the real `evaluate`/`BLOCKING_RULES` so a
 * future reorder cannot silently let a halted agent through.
 */

const POLICY = CONFIG.policy;
const HALTED = { allocation: '100000', remaining_budget: '100000', drawdown: '0', halted: true };

describe('agentHaltRule', () => {
  test('fires HALT when the agent is halted', () => {
    const r = agentHaltRule(openIntent(), cleanState({ agent: HALTED }), POLICY);
    expect(r).toMatchObject({ decision: 'HALT', severity: 'halt', rule_fired: 'agent_halt' });
  });

  test('passes (null) when the agent is not halted', () => {
    expect(agentHaltRule(openIntent(), cleanState(), POLICY)).toBeNull();
    expect(
      agentHaltRule(
        openIntent(),
        cleanState({ agent: { allocation: '1', remaining_budget: '1', drawdown: '0' } }),
        POLICY,
      ),
    ).toBeNull();
  });
});

describe('agent-halt ordering in evaluate', () => {
  test('registered as rule #1b: directly after kill switch', () => {
    const names = BLOCKING_RULES.map(
      (rule) => rule(transferIntent(), cleanState({ agent: HALTED }), POLICY)?.rule_fired,
    );
    // kill switch passes (inactive) → agent_halt fires first among the rest.
    expect(BLOCKING_RULES.indexOf(agentHaltRule)).toBe(1);
    expect(names[1]).toBe('agent_halt');
  });

  test('a halted agent HALTs even on an otherwise-rejectable drain', () => {
    // A transfer to a fresh wallet would REJECT/hard (rule #3); the per-agent
    // HALT dominates because it is earlier in the blocking phase.
    const r = evaluate(transferIntent({ size: 999_999 }), cleanState({ agent: HALTED }), POLICY);
    expect(r).toMatchObject({ decision: 'HALT', rule_fired: 'agent_halt' });
  });

  test('the global kill switch still dominates a per-agent HALT', () => {
    const r = evaluate(
      openIntent(),
      cleanState({ killSwitch: { active: true }, agent: HALTED }),
      POLICY,
    );
    expect(r.rule_fired).toBe('kill_switch');
  });

  test('an absent `halted` flag is treated as not halted (back-compat)', () => {
    // States built before P2.4 omit `halted`; they must not start HALTing.
    const r = evaluate(openIntent(), cleanState(), POLICY);
    expect(r.decision).toBe('ALLOW');
  });
});
