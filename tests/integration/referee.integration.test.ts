import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from '@neondatabase/serverless';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { loadMigrations, migrate, MIGRATIONS_DIR } from '@/lib/db/migrate';
import { insertAgent } from '@/lib/db/repos/agents';
import { insertIntent } from '@/lib/db/repos/intents';
import { listRecentPolicyEvents } from '@/lib/db/repos/policy-events';
import { insertRound } from '@/lib/db/repos/rounds';
import type { Queryable } from '@/lib/db/types';
import { intentHash } from '@/lib/intent/canonical';
import { signedIntentSchema } from '@/lib/intent/schema';
import { signIntent } from '@/lib/intent/sign';
import { runReferee } from '@/lib/referee/record';
import type { RefereeState } from '@/lib/referee/types';
import {
  TEST_PK,
  resolveTestSigner,
  transferInput,
  validOpenInput,
} from '@/tests/fixtures/intent-fixtures';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const ttl = new Date(NOW.getTime() + 60_000).toISOString();
const IDS = {
  intent_id: '11111111-1111-1111-1111-111111111111',
  agent_id: '22222222-2222-2222-2222-222222222222',
  round_id: '33333333-3333-3333-3333-333333333333',
};
const cleanState = (over: Partial<RefereeState> = {}): RefereeState => ({
  killSwitch: { active: false },
  agent: { allocation: '100000', remaining_budget: '100000', drawdown: '0' },
  ...over,
});

const policyRow = () => ({
  id: randomUUID(),
  intent_id: IDS.intent_id,
  agent_id: IDS.agent_id,
  round_id: IDS.round_id,
  rule_fired: 'allow',
  decision: 'ALLOW',
  severity: 'none',
  detail_json: {},
  created_at: NOW,
});

/** A fake that captures the insert and returns a valid policy_events row. */
class CapturingDb implements Queryable {
  public inserted?: Record<string, unknown>;
  async query<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    if (sql.startsWith('INSERT INTO policy_events') && params) {
      const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(', ');
      this.inserted = Object.fromEntries(cols.map((c, i) => [c.trim(), params[i]]));
    }
    return { rows: [policyRow() as R], rowCount: 1 };
  }
}

describe('runReferee — orchestration writes exactly one policy_event (fake db)', () => {
  test('a clean open is ALLOWed and recorded with its intent_hash', async () => {
    const db = new CapturingDb();
    const signed = await signIntent(validOpenInput({ ttl }), TEST_PK);
    const res = await runReferee({
      db,
      input: signed,
      ids: IDS,
      state: cleanState(),
      validate: { resolveSigner: resolveTestSigner, now: NOW },
    });
    expect(res.decision).toBe('ALLOW');
    expect(db.inserted).toMatchObject({ decision: 'ALLOW', severity: 'none', rule_fired: 'allow' });
    const detail = db.inserted!.detail_json as { intent_hash?: string };
    expect(detail.intent_hash).toBe(intentHash(signedIntentSchema.parse(signed)));
  });

  test('a drain transfer is REJECTed hard and recorded', async () => {
    const db = new CapturingDb();
    const signed = await signIntent(transferInput({ ttl }), TEST_PK);
    const res = await runReferee({
      db,
      input: signed,
      ids: IDS,
      state: cleanState(),
      validate: { resolveSigner: resolveTestSigner, now: NOW },
    });
    expect(res).toMatchObject({
      decision: 'REJECT',
      severity: 'hard',
      rule_fired: 'fresh_wallet_transfer_block',
    });
    expect(db.inserted).toMatchObject({ decision: 'REJECT', severity: 'hard' });
  });

  test('a structurally invalid intent is rejected at pre_validation (severity none)', async () => {
    const db = new CapturingDb();
    const res = await runReferee({
      db,
      input: { action: 'open' },
      ids: IDS,
      state: cleanState(),
      validate: { resolveSigner: resolveTestSigner, now: NOW },
    });
    expect(res).toMatchObject({
      decision: 'REJECT',
      severity: 'none',
      rule_fired: 'pre_validation',
    });
    expect(db.inserted).toMatchObject({ rule_fired: 'pre_validation', decision: 'REJECT' });
  });
});

/**
 * Real-Neon path: evaluate → write `policy_events` → read back and reconcile.
 * Isolated in a throwaway schema; skipped unless `DATABASE_URL` is set.
 */
const hasDb = typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0;
const describeDb = hasDb ? describe : describe.skip;

describeDb('runReferee → policy_events persistence (isolated schema on real Neon)', () => {
  const schema = `vec_test_${randomUUID().replace(/-/g, '')}`;
  let pool: Pool;
  let client: PoolClient;
  let db: Queryable & { query: PoolClient['query'] };

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    db = client as unknown as Queryable & { query: PoolClient['query'] };
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await migrate(pool, loadMigrations(MIGRATIONS_DIR), { direction: 'up', searchPath: schema });
  });

  afterAll(async () => {
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      client.release();
      await pool.end();
    }
  });

  test('a drain transfer is rejected and its policy_event is queryable', async () => {
    const agent = await insertAgent(db, { display_name: 'a', owner: 'ops', strategy_kind: 'seed' });
    const round = await insertRound(db, { index: 1, state: 'open' });
    const signed = await signIntent(transferInput({ ttl }), TEST_PK);
    const parsed = signedIntentSchema.parse(signed);
    const intent = await insertIntent(db, {
      round_id: round.id,
      agent_id: agent.id,
      intent_hash: intentHash(parsed),
      action: 'transfer',
      size: parsed.size,
      target_address: parsed.target_address ?? null,
      nonce: parsed.nonce,
      ttl: new Date(parsed.ttl),
      signature: parsed.signature,
      raw_json: parsed,
    });

    const res = await runReferee({
      db,
      input: signed,
      ids: { intent_id: intent.id, agent_id: agent.id, round_id: round.id },
      state: cleanState(),
      validate: { resolveSigner: resolveTestSigner, now: NOW },
    });
    expect(res.decision).toBe('REJECT');

    const events = await listRecentPolicyEvents(db, 10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      intent_id: intent.id,
      agent_id: agent.id,
      round_id: round.id,
      decision: 'REJECT',
      severity: 'hard',
      rule_fired: 'fresh_wallet_transfer_block',
    });
  });
});
