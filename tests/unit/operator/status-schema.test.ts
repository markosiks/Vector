import { describe, expect, test } from 'bun:test';

import { AGENT_STATUS } from '@/lib/db/schema';
import { OPERATOR_SETTABLE_STATUS, operatorStatusBody } from '@/lib/operator/agent-status-input';

/**
 * Regression: the operator console's per-agent HALT control must only ever set
 * `halted` or `active`. `'gated'` is a valid *DB* status but it does NOT stop
 * intent execution (the referee HALTs only on `status === 'halted'`); it merely
 * gates the agent out of capital allocation. Accepting it on the safety console
 * would hand the operator a HALT that silently does not halt. This test pins the
 * exclusion so a future "just reuse AGENT_STATUS" refactor cannot reopen it.
 */
describe('operator agent-status body schema', () => {
  test('accepts the two operator-settable states', () => {
    expect(operatorStatusBody.safeParse({ status: 'halted' }).success).toBe(true);
    expect(operatorStatusBody.safeParse({ status: 'active' }).success).toBe(true);
  });

  test("rejects 'gated' — it does not halt execution and is the scoring engine's domain", () => {
    expect(operatorStatusBody.safeParse({ status: 'gated' }).success).toBe(false);
  });

  test('rejects unknown statuses and extra keys (strict)', () => {
    expect(operatorStatusBody.safeParse({ status: 'paused' }).success).toBe(false);
    expect(operatorStatusBody.safeParse({ status: 'halted', extra: 1 }).success).toBe(false);
    expect(operatorStatusBody.safeParse({}).success).toBe(false);
  });

  test('the excluded value is genuinely a real DB status (so the exclusion is deliberate)', () => {
    // Guards against the enum drifting: 'gated' must still exist DB-side, just
    // be unreachable through the operator console.
    expect(AGENT_STATUS).toContain('gated');
    expect(OPERATOR_SETTABLE_STATUS).not.toContain('gated');
  });
});
