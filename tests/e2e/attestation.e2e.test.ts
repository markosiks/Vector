import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from '@neondatabase/serverless';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Address, Hex } from 'viem';

import { verifyDetailHash } from '@/lib/attestation/build';
import { mirrorAttestation, submitAndReconcile } from '@/lib/attestation/pipeline';
import type { FeedbackReceipt, ReceiptReader } from '@/lib/attestation/reconcile';
import type { FeedbackWriteArgs, FeedbackWriteClient } from '@/lib/attestation/submit';
import type { IdentityReader } from '@/lib/chain/identity';
import { loadMigrations, migrate, MIGRATIONS_DIR } from '@/lib/db/migrate';
import { insertAgent } from '@/lib/db/repos/agents';
import { getAttestationByAgentRound } from '@/lib/db/repos/attestations';
import { insertIntent } from '@/lib/db/repos/intents';
import { insertRound } from '@/lib/db/repos/rounds';
import type { OutcomeRow, PolicyEventRow } from '@/lib/db/schema';
import type { Queryable } from '@/lib/db/types';
import type { ScoreInputs, ScoreResult } from '@/lib/scoring/types';

/**
 * End-to-end of the attestation arc over a **real** Neon database with a scripted
 * chain seam (a funded testnet wallet + registered agents are out of band, so the
 * `giveFeedback`/receipt clients are injected). It walks the whole demo path —
 * mirror inside settle → submit one feedback → reconcile the receipt → the bytes
 * served at `feedbackURI` re-hash to the on-chain hash — and asserts the arc is
 * idempotent across a double settle and a reconcile re-run.
 *
 *   DATABASE_URL='postgresql://…' bun run test:e2e
 */
const hasDb = typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0;
const describeE2e = hasDb ? describe : describe.skip;

const ATTESTOR = '0x00000000000000000000000000000000000000a1' as Address;
const TX_HASH = `0x${'c'.repeat(64)}` as Hex;
const BASE = 'https://vector.app';

/** Records each giveFeedback and returns a fixed tx hash. */
function fakeWriter(): FeedbackWriteClient & { calls: FeedbackWriteArgs[] } {
  const calls: FeedbackWriteArgs[] = [];
  return {
    calls,
    giveFeedback: async (args) => {
      calls.push(args);
      return TX_HASH;
    },
  };
}

/** A receipt reader: pending for the first `pending` polls, then success. */
function fakeReceipts(pending: number): ReceiptReader {
  let seen = 0;
  return {
    getReceipt: async (): Promise<FeedbackReceipt | null> => {
      if (seen < pending) {
        seen += 1;
        return null;
      }
      return { status: 'success', blockNumber: 4_242n };
    },
  };
}

const attestableReader: IdentityReader = {
  ownerOf: async () => '0x00000000000000000000000000000000000000ff' as Address,
  isAuthorizedOrOwner: async () => false,
};

describeE2e('attestation pipeline e2e (real Neon + scripted chain)', () => {
  const schema = `vec_attest_e2e_${randomUUID().replace(/-/g, '')}`;
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

  function scoreFacts(agentId: string, roundId: string) {
    const result: ScoreResult = {
      raw_r: '70.000',
      score_r: '81.500',
      crashed: false,
      components: { perf: 0.6, w: 0.3, policy: 1, dd: 0 },
    };
    const inputs: ScoreInputs = {
      pnl_r: 250,
      car_r: 5000,
      soft: 0,
      hard: 0,
      halt: 0,
      dd_r: 0,
      drain_r: false,
    };
    const outcome: OutcomeRow = {
      id: randomUUID(),
      execution_id: null,
      agent_id: agentId,
      round_id: roundId,
      pnl_realized: '250',
      pnl_marked: '0',
      capital_at_risk: '5000',
      fees: '0.5',
      position_delta: '1',
      drawdown: '0',
      created_at: new Date(),
    };
    const event: PolicyEventRow = {
      id: randomUUID(),
      intent_id: randomUUID(),
      agent_id: agentId,
      round_id: roundId,
      rule_fired: 'allow',
      decision: 'ALLOW',
      severity: 'none',
      detail_json: null,
      created_at: new Date(),
    };
    return {
      agent: { seedId: 'seed-leader', uuid: agentId, onchainId: '1' as string | null },
      roundId,
      result,
      inputs,
      outcomes: [outcome],
      policyEvents: [event],
    };
  }

  test('mirror → submit → reconcile → served bytes verify, and the arc is idempotent', async () => {
    const agent = await insertAgent(db, { display_name: 'a', owner: 'o', strategy_kind: 'seed' });
    const round = await insertRound(db, { index: 300 });
    await insertIntent(db, {
      round_id: round.id,
      agent_id: agent.id,
      intent_hash: '0xseed-intent',
      action: 'open',
    });
    const facts = scoreFacts(agent.id, round.id);

    // 1) Settle-time mirror (optimistic, atomic with the score).
    const mirror = await mirrorAttestation(db, facts);
    expect(mirror.created).toBe(true);
    expect(mirror.attestation.chain_state).toBe('optimistic');
    expect(mirror.attestation.value).toBe('82'); // round(81.5)
    expect(mirror.attestation.tag2).toBe('clean');

    // 2) Post-commit submit + reconcile (off the critical path).
    const writer = fakeWriter();
    const out = await submitAndReconcile(
      { db, writer, reader: attestableReader, attestor: ATTESTOR, baseUrl: BASE },
      {
        receipts: fakeReceipts(1),
        policy: { baseDelayMs: 1, maxDelayMs: 1 },
        clock: { now: () => new Date(), sleep: async () => {} },
      },
      { attestationId: mirror.attestation.id, agentOnchainId: facts.agent.onchainId },
    );
    expect(out.submit.status).toBe('submitted');
    expect(writer.calls).toHaveLength(1);
    expect(out.reconcile?.status).toBe('confirmed');

    // 3) The persisted row is confirmed, and the served detail bytes verify.
    const settled = await getAttestationByAgentRound(db, agent.id, round.id);
    expect(settled?.chain_state).toBe('confirmed');
    expect(settled?.tx_hash).toBe(TX_HASH);
    expect(settled?.block_number).toBe('4242');
    expect(
      verifyDetailHash(settled!.feedback_detail as string, settled!.feedback_hash as string),
    ).toBe(true);

    // 4) Idempotency: a re-settle writes no second row; a re-submit sends no
    //    second tx and the reconcile re-run is a safe no-op.
    const reMirror = await mirrorAttestation(db, facts);
    expect(reMirror.created).toBe(false);
    expect(reMirror.attestation.id).toBe(mirror.attestation.id);

    const writer2 = fakeWriter();
    const reRun = await submitAndReconcile(
      { db, writer: writer2, reader: attestableReader, attestor: ATTESTOR, baseUrl: BASE },
      { receipts: fakeReceipts(0), clock: { now: () => new Date(), sleep: async () => {} } },
      { attestationId: mirror.attestation.id, agentOnchainId: facts.agent.onchainId },
    );
    expect(reRun.submit.status).toBe('already_submitted');
    expect(writer2.calls).toHaveLength(0);
    expect(reRun.reconcile?.status).toBe('confirmed');
  });
});
