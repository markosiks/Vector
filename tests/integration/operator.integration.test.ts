import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from '@neondatabase/serverless';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { loadMigrations, migrate, MIGRATIONS_DIR } from '@/lib/db/migrate';
import { insertAgent, setAgentStatus } from '@/lib/db/repos/agents';
import { insertCapitalAllocation } from '@/lib/db/repos/capital-allocations';
import { getKillSwitch, setKillSwitch } from '@/lib/db/repos/kill-switch';
import { insertOperatorAction, listRecentOperatorActions } from '@/lib/db/repos/operator-actions';
import { listRecentPolicyEvents } from '@/lib/db/repos/policy-events';
import { insertRound } from '@/lib/db/repos/rounds';
import type { Queryable } from '@/lib/db/types';
import { SEED_LEADER_ID } from '@/lib/agents/seed';
import { injectScriptedAttack } from '@/lib/operator/inject-attack';

/**
 * Integration: the operator console's write paths against a real Neon schema.
 * Skipped unless `DATABASE_URL` is set:
 *
 *   DATABASE_URL='postgresql://…' bun run test:integration
 *
 * Each test owns an isolated schema so the singletons (kill_switch) and the
 * audit log do not bleed across cases. The assertions target the invariants the
 * spec names: a state change and its audit row land together; the injected
 * attack reaches the *real* referee and is REJECTed with a persisted
 * policy_event; an idempotent retry writes nothing new; and both HALT modes cut
 * the injected drain.
 */

const hasDb = typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0;
const describeDb = hasDb ? describe : describe.skip;

describeDb('operator console — write paths (isolated schema on real Neon)', () => {
  const schema = `vec_op_${randomUUID().replace(/-/g, '')}`;
  let pool: Pool;
  let client: PoolClient;
  let db: Queryable & { query: PoolClient['query'] };

  let roundId: string;
  let leaderId: string; // display_name = SEED_LEADER_ID, attackable
  let otherId: string; // a non-seed agent, used for per-agent status tests

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    db = client as unknown as Queryable & { query: PoolClient['query'] };
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await migrate(pool, loadMigrations(MIGRATIONS_DIR), { direction: 'up', searchPath: schema });

    const round = await insertRound(db, { index: 0, state: 'open' });
    roundId = round.id;

    // The leader must map to a known seed signer for the attack to target it.
    const leader = await insertAgent(db, {
      display_name: SEED_LEADER_ID,
      owner: 'ops',
      strategy_kind: 'seed',
      score_current: '90.000',
    });
    leaderId = leader.id;
    const other = await insertAgent(db, {
      display_name: 'follower',
      owner: 'ops',
      strategy_kind: 'external',
      score_current: '50.000',
    });
    otherId = other.id;

    await insertCapitalAllocation(db, {
      agent_id: leaderId,
      round_id: roundId,
      amount: '1000',
      target_weight: '0.5',
      prev_weight: '0',
      delta: '0.5',
      trigger: 'settle',
    });
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
    await pool.end();
  });

  test('kill-switch toggle persists and is auditable', async () => {
    await setKillSwitch(db, { active: true, reason: 'incident', set_by: 'operator' });
    await insertOperatorAction(db, {
      kind: 'kill_switch',
      detail_json: { active: true, reason: 'incident' },
    });

    const row = await getKillSwitch(db);
    expect(row?.active).toBe(true);
    expect(row?.reason).toBe('incident');

    const actions = await listRecentOperatorActions(db, 10);
    expect(actions.some((a) => a.kind === 'kill_switch')).toBe(true);

    // Reset for later tests.
    await setKillSwitch(db, { active: false, reason: null, set_by: 'operator' });
  });

  test('per-agent status write persists', async () => {
    const halted = await setAgentStatus(db, otherId, 'halted');
    expect(halted?.status).toBe('halted');
    await insertOperatorAction(db, {
      kind: 'agent_status',
      agent_id: otherId,
      detail_json: { status: 'halted' },
    });
    const back = await setAgentStatus(db, otherId, 'active');
    expect(back?.status).toBe('active');
  });

  test('setAgentStatus on an unknown id returns null', async () => {
    expect(await setAgentStatus(db, randomUUID(), 'halted')).toBeNull();
  });

  test('scripted attack reaches the real referee → REJECT with a persisted policy_event', async () => {
    const result = await injectScriptedAttack({ db, idempotencyKey: randomUUID() });
    expect(result.duplicate).toBe(false);
    expect(result.decision.decision).toBe('REJECT');
    expect(result.decision.rule_fired).toBe('fresh_wallet_transfer_block');
    expect(result.intentId).not.toBeNull();

    const events = await listRecentPolicyEvents(db, 10);
    expect(
      events.some(
        (e) => e.intent_id === result.intentId && e.rule_fired === 'fresh_wallet_transfer_block',
      ),
    ).toBe(true);
  });

  test('a repeated idempotency key writes no second Intent or policy_event', async () => {
    const key = randomUUID();
    const first = await injectScriptedAttack({ db, idempotencyKey: key });
    const before = (await listRecentPolicyEvents(db, 100)).length;

    const second = await injectScriptedAttack({ db, idempotencyKey: key });
    expect(second.duplicate).toBe(true);
    // A truly idempotent retry reports the *persisted* Intent — the same id and
    // hash as the original, read back — not a freshly built one.
    expect(second.intentId).toBe(first.intentId);
    expect(second.intentHash).toBe(first.intentHash);
    // And the *recorded* decision, reconstructed from the original policy_event.
    expect(second.decision.decision).toBe('REJECT');
    expect(second.decision.rule_fired).toBe('fresh_wallet_transfer_block');

    const after = (await listRecentPolicyEvents(db, 100)).length;
    expect(after).toBe(before); // no new policy_event from the retry
  });

  test('an idempotent retry reports the recorded decision, not the current state', async () => {
    // Original injection is REJECTed and recorded.
    const key = randomUUID();
    const first = await injectScriptedAttack({ db, idempotencyKey: key });
    expect(first.decision.decision).toBe('REJECT');

    // A stop is later activated. A naive retry that re-evaluates against the
    // *current* state would now report HALT — a decision that never happened to
    // the original Intent. The truthful retry reports the recorded REJECT.
    await setKillSwitch(db, { active: true, reason: 'freeze', set_by: 'operator' });
    try {
      const retry = await injectScriptedAttack({ db, idempotencyKey: key });
      expect(retry.duplicate).toBe(true);
      expect(retry.intentId).toBe(first.intentId);
      expect(retry.decision.decision).toBe('REJECT');
      expect(retry.decision.rule_fired).toBe('fresh_wallet_transfer_block');
    } finally {
      await setKillSwitch(db, { active: false, reason: null, set_by: 'operator' });
    }
  });

  test('a global HALT turns the injected drain into a HALT', async () => {
    await setKillSwitch(db, { active: true, reason: 'freeze', set_by: 'operator' });
    const result = await injectScriptedAttack({ db, idempotencyKey: randomUUID() });
    expect(result.decision.decision).toBe('HALT');
    expect(result.decision.rule_fired).toBe('kill_switch');
    await setKillSwitch(db, { active: false, reason: null, set_by: 'operator' });
  });

  test('a per-agent HALT on the leader turns the injected drain into a HALT', async () => {
    await setAgentStatus(db, leaderId, 'halted');
    const result = await injectScriptedAttack({ db, idempotencyKey: randomUUID() });
    expect(result.decision.decision).toBe('HALT');
    expect(result.decision.rule_fired).toBe('agent_halt');
    await setAgentStatus(db, leaderId, 'active');
  });
});

describe('operator integration (skipped without DATABASE_URL)', () => {
  test.skipIf(hasDb)('placeholder so the file always reports at least one test', () => {
    expect(hasDb).toBe(false);
  });
});
