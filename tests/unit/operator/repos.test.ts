import { describe, expect, test } from 'bun:test';

import { setAgentStatus } from '@/lib/db/repos/agents';
import { insertOperatorAction, listRecentOperatorActions } from '@/lib/db/repos/operator-actions';
import type { Queryable } from '@/lib/db/types';

/** A fake that records calls and returns a pre-seeded row set. */
class FakeDb implements Queryable {
  public last?: { sql: string; params?: readonly unknown[] };
  public readonly calls: { sql: string; params?: readonly unknown[] }[] = [];
  constructor(private readonly rows: Record<string, unknown>[]) {}
  async query<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    this.last = params === undefined ? { sql } : { sql, params };
    this.calls.push(this.last);
    return { rows: this.rows as R[], rowCount: this.rows.length };
  }
}

const AGENT_ROW = {
  id: '11111111-1111-1111-1111-111111111111',
  agent_id_onchain: null,
  display_name: 'seed-leader',
  owner: 'ops',
  strategy_kind: 'seed',
  status: 'halted',
  score_current: '50.000',
  created_at: new Date('2026-06-06T00:00:00Z'),
};

const ACTION_ROW = {
  id: '22222222-2222-2222-2222-222222222222',
  kind: 'kill_switch',
  actor: 'operator',
  agent_id: null,
  detail_json: { active: true, reason: null },
  created_at: new Date('2026-06-06T00:00:00Z'),
};

describe('setAgentStatus', () => {
  test('builds a parameterized UPDATE … RETURNING and binds id+status', async () => {
    const db = new FakeDb([AGENT_ROW]);
    const row = await setAgentStatus(db, AGENT_ROW.id, 'halted');
    expect(db.last?.sql).toBe('UPDATE agents SET status = $2 WHERE id = $1 RETURNING *');
    expect(db.last?.params).toEqual([AGENT_ROW.id, 'halted']);
    expect(row?.status).toBe('halted');
  });

  test('returns null when no row matches (unknown id → 404 upstream)', async () => {
    const db = new FakeDb([]);
    expect(await setAgentStatus(db, AGENT_ROW.id, 'active')).toBeNull();
  });
});

describe('insertOperatorAction', () => {
  test('parameterizes the audit insert and binds the curated detail', async () => {
    const db = new FakeDb([ACTION_ROW]);
    await insertOperatorAction(db, {
      kind: 'kill_switch',
      detail_json: { active: true, reason: null },
    });
    expect(db.last?.sql).toContain('INSERT INTO operator_actions');
    expect(db.last?.sql).toContain('RETURNING *');
    // agent_id defaults to null; detail is bound, never inlined.
    expect(db.last?.params).toContain(null);
  });
});

describe('listRecentOperatorActions', () => {
  test('orders newest-first and bounds with the limit param', async () => {
    const db = new FakeDb([ACTION_ROW]);
    await listRecentOperatorActions(db, 25);
    expect(db.last?.sql).toBe(
      'SELECT * FROM operator_actions ORDER BY created_at DESC, id DESC LIMIT $1',
    );
    expect(db.last?.params).toEqual([25]);
  });
});
