import { describe, expect, test } from 'bun:test';

import { insertAgent, listAgentsByScore } from '@/lib/db/repos/agents';
import { insertAttestation } from '@/lib/db/repos/attestations';
import { insertIntent } from '@/lib/db/repos/intents';
import { setKillSwitch } from '@/lib/db/repos/kill-switch';
import { insertScore } from '@/lib/db/repos/scores';
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
  status: 'active',
  score_current: '50.000',
  created_at: new Date('2026-06-06T00:00:00Z'),
};

describe('insertAgent', () => {
  test('builds a parameterized INSERT and binds (no inline values)', async () => {
    const db = new FakeDb([AGENT_ROW]);
    await insertAgent(db, { display_name: 'seed-leader', owner: 'ops', strategy_kind: 'seed' });
    expect(db.last?.sql).toBe(
      'INSERT INTO agents (display_name, owner, strategy_kind) VALUES ($1, $2, $3) RETURNING *',
    );
    expect(db.last?.params).toEqual(['seed-leader', 'ops', 'seed']);
  });

  test('coerces a numeric score input to its string form', async () => {
    const db = new FakeDb([AGENT_ROW]);
    await insertAgent(db, {
      display_name: 'x',
      owner: 'ops',
      strategy_kind: 'external',
      score_current: 42,
    });
    expect(db.last?.params).toContain('42');
  });

  test('parses and types the returned row', async () => {
    const db = new FakeDb([AGENT_ROW]);
    const row = await insertAgent(db, { display_name: 'a', owner: 'b', strategy_kind: 'seed' });
    expect(row.status).toBe('active');
    expect(row.score_current).toBe('50.000');
    expect(row.created_at).toBeInstanceOf(Date);
  });

  test('rejects a row that violates the schema (bad enum from the DB)', async () => {
    const db = new FakeDb([{ ...AGENT_ROW, status: 'bogus' }]);
    await expect(
      insertAgent(db, { display_name: 'a', owner: 'b', strategy_kind: 'seed' }),
    ).rejects.toThrow();
  });
});

describe('listAgentsByScore', () => {
  test('orders by score and binds the limit', async () => {
    const db = new FakeDb([AGENT_ROW]);
    await listAgentsByScore(db, 25);
    expect(db.last?.sql).toContain('ORDER BY score_current DESC');
    expect(db.last?.params).toEqual([25]);
  });
});

describe('insertIntent', () => {
  test('passes target_address through and coerces numeric fields', async () => {
    const row = {
      id: '22222222-2222-2222-2222-222222222222',
      round_id: '00000000-0000-0000-0000-0000000000b1',
      agent_id: '00000000-0000-0000-0000-0000000000a1',
      intent_hash: '0xabc',
      action: 'transfer',
      market: null,
      side: null,
      size: '5',
      leverage: null,
      tp: null,
      sl: null,
      max_slippage: null,
      target_address: '0xdead',
      nonce: null,
      ttl: null,
      signature: null,
      raw_json: null,
      created_at: new Date(),
    };
    const db = new FakeDb([row]);
    await insertIntent(db, {
      round_id: '00000000-0000-0000-0000-0000000000b1',
      agent_id: '00000000-0000-0000-0000-0000000000a1',
      intent_hash: '0xabc',
      action: 'transfer',
      size: 5,
      target_address: '0xdead',
    });
    expect(db.last?.params).toContain('0xdead');
    expect(db.last?.params).toContain('5'); // numeric coerced to string
    // SQL only references our columns + placeholders; the address is a param.
    expect(db.last?.sql).not.toContain('0xdead');
  });
});

describe('insertScore', () => {
  test('coerces raw_r and score_r to strings to preserve precision', async () => {
    const row = {
      id: '33333333-3333-3333-3333-333333333333',
      agent_id: '00000000-0000-0000-0000-0000000000a1',
      round_id: '00000000-0000-0000-0000-0000000000b1',
      raw_r: '0.42',
      score_r: '50.000',
      components_json: null,
      created_at: new Date(),
    };
    const db = new FakeDb([row]);
    await insertScore(db, {
      agent_id: '00000000-0000-0000-0000-0000000000a1',
      round_id: '00000000-0000-0000-0000-0000000000b1',
      raw_r: '0.42',
      score_r: 50,
    });
    expect(db.last?.params).toEqual([
      '00000000-0000-0000-0000-0000000000a1',
      '00000000-0000-0000-0000-0000000000b1',
      '0.42',
      '50',
    ]);
  });
});

describe('insertAttestation', () => {
  test('coerces a bigint block_number to string and keeps null when absent', async () => {
    const row = {
      id: '44444444-4444-4444-4444-444444444444',
      agent_id: '00000000-0000-0000-0000-0000000000a1',
      round_id: '00000000-0000-0000-0000-0000000000b1',
      value: '50',
      value_decimals: 0,
      tag1: null,
      tag2: null,
      feedback_uri: null,
      feedback_hash: null,
      chain_state: 'optimistic',
      tx_hash: null,
      block_number: '12345',
      created_at: new Date(),
      confirmed_at: null,
    };
    const db = new FakeDb([row]);
    await insertAttestation(db, {
      agent_id: '00000000-0000-0000-0000-0000000000a1',
      round_id: '00000000-0000-0000-0000-0000000000b1',
      value: 50n,
      block_number: 12345n,
    });
    expect(db.last?.params).toContain('50');
    expect(db.last?.params).toContain('12345');
  });
});

describe('setKillSwitch', () => {
  test('upserts the singleton (id = 1) and binds the inputs', async () => {
    const row = {
      id: 1,
      active: true,
      reason: 'drain detected',
      set_by: 'operator',
      updated_at: new Date(),
    };
    const db = new FakeDb([row]);
    const out = await setKillSwitch(db, {
      active: true,
      reason: 'drain detected',
      set_by: 'operator',
    });
    expect(db.last?.sql).toContain('ON CONFLICT (id) DO UPDATE');
    expect(db.last?.params).toEqual([true, 'drain detected', 'operator']);
    expect(out.active).toBe(true);
  });

  test('defaults missing reason/set_by to null', async () => {
    const db = new FakeDb([
      { id: 1, active: false, reason: null, set_by: null, updated_at: new Date() },
    ]);
    await setKillSwitch(db, { active: false });
    expect(db.last?.params).toEqual([false, null, null]);
  });
});
