import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from '@neondatabase/serverless';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { verifyDetailHash } from '@/lib/attestation/build';
import { mirrorAttestation } from '@/lib/attestation/pipeline';
import { loadMigrations, migrate, MIGRATIONS_DIR } from '@/lib/db/migrate';
import { insertAgent } from '@/lib/db/repos/agents';
import {
  getAttestationByAgentRound,
  insertAttestationOptimistic,
  recordAttestationSubmission,
  reconcileAttestation,
} from '@/lib/db/repos/attestations';
import { insertIntent } from '@/lib/db/repos/intents';
import { insertRound } from '@/lib/db/repos/rounds';
import type { OutcomeRow, PolicyEventRow } from '@/lib/db/schema';
import type { Queryable } from '@/lib/db/types';
import type { ScoreInputs, ScoreResult } from '@/lib/scoring/types';

/**
 * Integration tests for the attestation pipeline against a **real** Neon
 * database in a throwaway schema (the data-model suite's pattern). They pin the
 * persistence-level guarantees that the unit fakes only approximate: the
 * `ON CONFLICT DO NOTHING` mirror, the `tx_hash IS NULL` single-winner latch,
 * and the `chain_state = 'optimistic'` forward-only reconcile guard — all under
 * the actual constraints (UNIQUE, the int128/`bytes32` CHECKs, the FKs).
 *
 *   DATABASE_URL='postgresql://…' bun run test:integration
 */
const hasDb = typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0;
const describeDb = hasDb ? describe : describe.skip;

const TX_A = `0x${'a'.repeat(64)}`;
const TX_B = `0x${'b'.repeat(64)}`;

describeDb('attestation pipeline (isolated schema on real Neon)', () => {
  const schema = `vec_attest_${randomUUID().replace(/-/g, '')}`;
  let pool: Pool;
  let client: PoolClient;
  let db: Queryable;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    db = client as unknown as Queryable;
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

  /** Seed a fresh agent + round and return their ids. */
  async function freshAgentRound(index: number): Promise<{ agentId: string; roundId: string }> {
    const agent = await insertAgent(db, { display_name: 'a', owner: 'o', strategy_kind: 'seed' });
    const round = await insertRound(db, { index });
    return { agentId: agent.id, roundId: round.id };
  }

  test('the optimistic mirror is idempotent under the UNIQUE (agent_id, round_id)', async () => {
    const { agentId, roundId } = await freshAgentRound(200);
    const first = await insertAttestationOptimistic(db, {
      agent_id: agentId,
      round_id: roundId,
      value: 74,
      value_decimals: 0,
      tag1: roundId,
      tag2: 'violation',
      feedback_hash: `0x${'a'.repeat(64)}`,
      feedback_detail: '{"x":1}',
      chain_state: 'optimistic',
    });
    expect(first).not.toBeNull();

    const second = await insertAttestationOptimistic(db, {
      agent_id: agentId,
      round_id: roundId,
      value: 99,
      value_decimals: 0,
      chain_state: 'optimistic',
    });
    expect(second).toBeNull(); // ON CONFLICT DO NOTHING

    const found = await getAttestationByAgentRound(db, agentId, roundId);
    expect(found?.id).toBe(first!.id);
    expect(found?.value).toBe('74'); // history not overwritten
  });

  test('recordAttestationSubmission is a single winner (tx_hash IS NULL latch)', async () => {
    const { agentId, roundId } = await freshAgentRound(201);
    const row = await insertAttestationOptimistic(db, {
      agent_id: agentId,
      round_id: roundId,
      value: 50,
      value_decimals: 0,
      chain_state: 'optimistic',
    });
    const won = await recordAttestationSubmission(db, {
      id: row!.id,
      feedbackUri: 'https://vector.app/x',
      txHash: TX_A,
    });
    expect(won?.tx_hash).toBe(TX_A);

    const lost = await recordAttestationSubmission(db, {
      id: row!.id,
      feedbackUri: 'https://vector.app/y',
      txHash: TX_B,
    });
    expect(lost).toBeNull(); // already claimed — never a second tx recorded
  });

  test('reconcile is forward-only: a confirmation cannot be overwritten by a late failed', async () => {
    const { agentId, roundId } = await freshAgentRound(202);
    const row = await insertAttestationOptimistic(db, {
      agent_id: agentId,
      round_id: roundId,
      value: 50,
      value_decimals: 0,
      chain_state: 'optimistic',
    });
    const confirmed = await reconcileAttestation(db, {
      id: row!.id,
      chainState: 'confirmed',
      blockNumber: 12_345,
      confirmedAt: new Date(),
    });
    expect(confirmed?.chain_state).toBe('confirmed');
    expect(confirmed?.block_number).toBe('12345');

    const lateFail = await reconcileAttestation(db, { id: row!.id, chainState: 'failed' });
    expect(lateFail).toBeNull(); // guard blocked it
    const after = await getAttestationByAgentRound(db, agentId, roundId);
    expect(after?.chain_state).toBe('confirmed');
  });

  test('mirrorAttestation stores bytes that re-hash to the on-chain feedback_hash', async () => {
    const { agentId, roundId } = await freshAgentRound(203);
    await insertIntent(db, {
      round_id: roundId,
      agent_id: agentId,
      intent_hash: '0xseed-intent',
      action: 'open',
    });

    const result: ScoreResult = {
      raw_r: '70.000',
      score_r: '73.500',
      crashed: false,
      components: { perf: 0.5, w: 0.25, policy: 0.9, dd: 0.05 },
    };
    const inputs: ScoreInputs = {
      pnl_r: 120,
      car_r: 3000,
      soft: 1,
      hard: 0,
      halt: 0,
      dd_r: 0.05,
      drain_r: false,
    };
    const outcome: OutcomeRow = {
      id: randomUUID(),
      execution_id: null,
      agent_id: agentId,
      round_id: roundId,
      pnl_realized: '100',
      pnl_marked: '20',
      capital_at_risk: '1000',
      fees: '0.25',
      position_delta: '-2',
      drawdown: '0.05',
      created_at: new Date(),
    };
    const event: PolicyEventRow = {
      id: randomUUID(),
      intent_id: randomUUID(),
      agent_id: agentId,
      round_id: roundId,
      rule_fired: 'size_cap',
      decision: 'CLIP',
      severity: 'soft',
      detail_json: null,
      created_at: new Date(),
    };

    const { attestation, created } = await mirrorAttestation(db, {
      agent: { seedId: 'seed-leader', uuid: agentId, onchainId: null },
      roundId,
      result,
      inputs,
      outcomes: [outcome],
      policyEvents: [event],
    });

    expect(created).toBe(true);
    expect(attestation.value).toBe('74');
    expect(attestation.tag2).toBe('violation');
    expect(
      verifyDetailHash(attestation.feedback_detail as string, attestation.feedback_hash as string),
    ).toBe(true);
  });
});
