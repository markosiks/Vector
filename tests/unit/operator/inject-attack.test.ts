import { describe, expect, test } from 'bun:test';

import { SEED_AGENTS } from '@/lib/agents/seed';
import { injectScriptedAttack } from '@/lib/operator/inject-attack';
import type { Queryable } from '@/lib/db/types';

/**
 * Regression for the operator attack path's kill-switch read contract.
 *
 * The live trading pipeline reads the kill switch *fail-open* (a transient
 * outage must never HALT every agent). The operator console runs inside the
 * audit transaction and has the opposite contract: a kill-switch read fault must
 * ABORT the injection so the whole transaction rolls back, rather than fail open
 * and persist an attack whose recorded decision/rule reflects an "inactive"
 * switch that was never actually observed. This test drives a fault on the
 * `kill_switch` read and asserts the error propagates (the route's wrapper then
 * turns it into a 500 with nothing written).
 */

const leader = SEED_AGENTS[0];
if (leader === undefined) throw new Error('seed roster is empty');
const LEADER_DISPLAY_NAME = leader.id;
const KILL_SWITCH_FAULT = new Error('connection reset by peer');

/** Routes queries by table, returning valid rows until the kill_switch read. */
class KillSwitchFaultDb implements Queryable {
  async query<R = Record<string, unknown>>(
    sql: string,
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    if (sql.includes('kill_switch')) {
      throw KILL_SWITCH_FAULT;
    }
    if (sql.includes('FROM rounds')) {
      return this.wrap([
        {
          id: '11111111-1111-1111-1111-111111111111',
          index: 1,
          state: 'open',
          seed_ref: null,
          started_at: new Date('2026-06-06T00:00:00Z'),
          settled_at: null,
        },
      ]);
    }
    if (sql.includes('FROM agents')) {
      // Leaderboard: one attackable seed leader.
      return this.wrap([
        {
          id: '22222222-2222-2222-2222-222222222222',
          agent_id_onchain: null,
          display_name: LEADER_DISPLAY_NAME,
          owner: 'ops',
          strategy_kind: 'seed',
          status: 'active',
          score_current: '99.000',
          created_at: new Date('2026-06-06T00:00:00Z'),
          allocation_amount: '1000',
        },
      ]);
    }
    return this.wrap([]);
  }

  private wrap<R>(rows: unknown[]): { rows: R[]; rowCount: number | null } {
    return { rows: rows as R[], rowCount: rows.length };
  }
}

describe('injectScriptedAttack — kill-switch read is fail-closed in the operator path', () => {
  test('a kill_switch read fault aborts the injection instead of failing open', async () => {
    const db = new KillSwitchFaultDb();
    await expect(injectScriptedAttack({ db, idempotencyKey: 'op-attack-test-1' })).rejects.toThrow(
      KILL_SWITCH_FAULT,
    );
  });
});
