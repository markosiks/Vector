import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from '@neondatabase/serverless';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  toAgentDto,
  toAttestationDto,
  toIntentDto,
  toOutcomeDto,
  toPolicyEventDto,
  toScoreDto,
} from '@/lib/api/dto';
import { loadMigrations, migrate, MIGRATIONS_DIR } from '@/lib/db/migrate';
import { insertAgent } from '@/lib/db/repos/agents';
import { insertAttestation, listAttestationsPage } from '@/lib/db/repos/attestations';
import { insertIntent, listIntentsByAgent } from '@/lib/db/repos/intents';
import { insertOutcome, listRecentOutcomesByAgent } from '@/lib/db/repos/outcomes';
import { insertPolicyEvent, listRecentPolicyEventsByAgent } from '@/lib/db/repos/policy-events';
import { insertRound } from '@/lib/db/repos/rounds';
import { insertScore, listScoreHistoryByAgent } from '@/lib/db/repos/scores';
import type { Queryable } from '@/lib/db/types';
import { score as computeScore } from '@/lib/scoring/score';
import { CONFIG } from '@/lib/config/constants';
import {
  breakdownFrom,
  buildEwmaSeries,
  chainStateMeta,
  correlateIntents,
  explorerTxUrl,
  isStuckOptimistic,
} from '@/lib/credibility';

/**
 * Integration: the credibility screens against a **real** Neon database,
 * isolated in a throwaway schema. Skipped unless `DATABASE_URL` is set:
 *
 *   DATABASE_URL='postgresql://…' bun run test:integration
 *
 * It writes a realistic agent (scored rounds with `components_json`, intents +
 * referee decisions, outcomes, attestations across chain states), reads it back
 * through the *exact* repos + DTO mappers the `/api/agents/[id]` and
 * `/api/attestations` routes use, and runs the screen logic over that output —
 * proving the P2.3 presentation consumes the P1.5 serialization faithfully:
 * round-index EWMA order, breakdown matching the scorer's stored `raw_r`,
 * intent↔referee correlation, and real explorer links on confirmed rows.
 */

const hasDb = typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0;
const describeDb = hasDb ? describe : describe.skip;

describeDb('Credibility screens over a real agent (isolated schema)', () => {
  const schema = `vec_cred_${randomUUID().replace(/-/g, '')}`;
  let pool: Pool;
  let client: PoolClient;
  let db: Queryable & { query: PoolClient['query'] };

  let agentId: string;
  const cfg = CONFIG.scoring;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    db = client as unknown as Queryable & { query: PoolClient['query'] };
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await migrate(pool, loadMigrations(MIGRATIONS_DIR), { direction: 'up', searchPath: schema });

    const agent = await insertAgent(db, {
      display_name: 'cred-subject',
      owner: 'ops',
      strategy_kind: 'seed',
      score_current: '0',
    });
    agentId = agent.id;

    // Three scored rounds, inserted out of index order to prove the read
    // re-orders by round index. Each score carries real scorer components.
    const inputs = [
      { pnl_r: 120, car_r: 1000, soft: 0, hard: 0, halt: 0, dd_r: 0, drain_r: false },
      { pnl_r: -40, car_r: 500, soft: 1, hard: 0, halt: 0, dd_r: 0.3, drain_r: false },
      { pnl_r: 30, car_r: 200, soft: 0, hard: 1, halt: 0, dd_r: 0.1, drain_r: false },
    ];
    let prev = cfg.score_0;
    const rounds = [2, 0, 1]; // deliberately unsorted insert order
    for (const idx of rounds) {
      const round = await insertRound(db, { index: idx, state: 'settled' });
      const r = computeScore(inputs[idx]!, prev, cfg);
      prev = Number(r.score_r);
      await insertScore(db, {
        agent_id: agentId,
        round_id: round.id,
        raw_r: r.raw_r,
        score_r: r.score_r,
        components_json: r.components,
      });
      if (idx === 0) {
        // Round 0 carries an intent that the referee REJECTed, plus an outcome.
        const intent = await insertIntent(db, {
          round_id: round.id,
          agent_id: agentId,
          intent_hash: '0xopen',
          action: 'open',
        });
        await insertPolicyEvent(db, {
          intent_id: intent.id,
          agent_id: agentId,
          round_id: round.id,
          rule_fired: 'leverage_cap',
          decision: 'CLIP',
          severity: 'soft',
        });
        await insertPolicyEvent(db, {
          intent_id: intent.id,
          agent_id: agentId,
          round_id: round.id,
          rule_fired: 'kill_switch',
          decision: 'REJECT',
          severity: 'hard',
        });
        await insertOutcome(db, {
          agent_id: agentId,
          round_id: round.id,
          pnl_realized: '12.5',
          capital_at_risk: '1000.000000000000000001',
          fees: '0.25',
          drawdown: '0.05',
        });
        await insertAttestation(db, {
          agent_id: agentId,
          round_id: round.id,
          value: '73',
          chain_state: 'confirmed',
          tx_hash: `0x${'b'.repeat(64)}`,
          block_number: '12345678',
        });
      }
    }
  });

  afterAll(async () => {
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      client.release();
      await pool.end();
    }
  });

  test('EWMA series follows round-index order, not insert order', async () => {
    const scores = (await listScoreHistoryByAgent(db, agentId)).map(toScoreDto);
    const series = buildEwmaSeries(scores);
    expect(series.points).toHaveLength(3);
    // Strictly increasing index, gap-free.
    expect(series.points.map((p) => p.index)).toEqual([0, 1, 2]);
  });

  test('breakdown reconstructs the scorer-stored raw_r for every round', async () => {
    const scores = (await listScoreHistoryByAgent(db, agentId)).map(toScoreDto);
    for (const s of scores) {
      const b = breakdownFrom(s.components);
      expect(b).not.toBeNull();
      expect(b!.raw).toBeCloseTo(Number(s.raw_r), 4);
    }
  });

  test('intent correlates to its dominant referee decision (REJECT over CLIP)', async () => {
    const intents = (await listIntentsByAgent(db, agentId, 50)).map(toIntentDto);
    const events = (await listRecentPolicyEventsByAgent(db, agentId, 50)).map(toPolicyEventDto);
    const rows = correlateIntents(intents, events);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.events).toHaveLength(2);
    expect(rows[0]!.worst!.decision).toBe('REJECT');
  });

  test('outcome DTO keeps full numeric precision the screen renders', async () => {
    const outcomes = (await listRecentOutcomesByAgent(db, agentId, 50)).map(toOutcomeDto);
    expect(outcomes[0]!.capital_at_risk).toBe('1000.000000000000000001');
  });

  test('confirmed attestation yields a real explorer link; agent DTO maps', async () => {
    const rows = await listAttestationsPage(db, { limit: 50 });
    const dtos = rows.map(toAttestationDto);
    const confirmed = dtos.find((a) => a.chain_state === 'confirmed')!;
    expect(chainStateMeta(confirmed.chain_state).terminal).toBe(true);
    expect(explorerTxUrl(confirmed.tx_hash)).toMatch(/\/tx\/0x[0-9a-f]{64}$/);
    expect(isStuckOptimistic(confirmed, new Date())).toBe(false);

    const agentRow = await db.query('SELECT * FROM agents WHERE id = $1', [agentId]);
    expect(() => toAgentDto(agentRow.rows[0] as never)).not.toThrow();
  });
});
