import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from '@neondatabase/serverless';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { loadMigrations, migrate, MIGRATIONS_DIR } from '@/lib/db/migrate';
import { getAgent, insertAgent } from '@/lib/db/repos/agents';
import { insertIntent } from '@/lib/db/repos/intents';
import { insertOutcome, listOutcomesByAgentRound } from '@/lib/db/repos/outcomes';
import { insertPolicyEvent, listPolicyEventsByAgentRound } from '@/lib/db/repos/policy-events';
import { insertRound } from '@/lib/db/repos/rounds';
import { listScoreHistoryByAgent } from '@/lib/db/repos/scores';
import type { Queryable } from '@/lib/db/types';
import { deriveScoreInputs, recordScore } from '@/lib/scoring/record';

/**
 * Integration: outcomes + policy_events → score → write `scores` → read back and
 * verify `components_json` (§9), plus a multi-round EWMA chain persisted in Neon.
 * Skipped unless `DATABASE_URL` is set; runs in a throwaway schema.
 */

const hasDb = typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0;
const describeDb = hasDb ? describe : describe.skip;

describeDb('scoring engine (isolated schema on real Neon)', () => {
  const schema = `vec_test_${randomUUID().replace(/-/g, '')}`;
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

  async function seedRoundAgent(displayName: string) {
    const agent = await insertAgent(db, {
      display_name: displayName,
      owner: 'ops',
      strategy_kind: 'seed',
    });
    const round = await insertRound(db, { index: nextIndex() });
    return { agentId: agent.id, roundId: round.id };
  }

  let idx = 0;
  const nextIndex = () => idx++;

  async function addPolicyEvent(
    agentId: string,
    roundId: string,
    over: {
      rule_fired: string;
      decision: 'ALLOW' | 'CLIP' | 'REJECT' | 'HALT';
      severity: 'none' | 'soft' | 'hard' | 'halt';
    },
  ) {
    const intent = await insertIntent(db, {
      round_id: roundId,
      agent_id: agentId,
      intent_hash: `0x${randomUUID().replace(/-/g, '')}${'0'.repeat(32)}`,
      action: 'open',
      market: 'BTC-PERP',
      side: 'long',
      size: 100,
    });
    return insertPolicyEvent(db, {
      intent_id: intent.id,
      agent_id: agentId,
      round_id: roundId,
      ...over,
    });
  }

  test('outcomes + policy_events drive a persisted score and components_json round-trips', async () => {
    const { agentId, roundId } = await seedRoundAgent('scorer-1');
    await insertOutcome(db, {
      agent_id: agentId,
      round_id: roundId,
      pnl_realized: '600',
      pnl_marked: '0',
      capital_at_risk: '20000',
      drawdown: '0.05',
    });
    await addPolicyEvent(agentId, roundId, {
      rule_fired: 'size_cap',
      decision: 'CLIP',
      severity: 'soft',
    });

    const outcomes = await listOutcomesByAgentRound(db, agentId, roundId);
    const events = await listPolicyEventsByAgentRound(db, agentId, roundId);
    const inputs = deriveScoreInputs(outcomes, events);
    expect(inputs).toMatchObject({ pnl_r: 600, car_r: 20000, soft: 1, hard: 0, halt: 0 });

    const { result } = await recordScore({ db, agentId, roundId, inputs });

    const persisted = await listScoreHistoryByAgent(db, agentId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.score_r).toBe(result.score_r);
    expect(persisted[0]!.raw_r).toBe(result.raw_r);
    expect(persisted[0]!.components_json).toEqual(result.components);

    const agent = await getAgent(db, agentId);
    expect(agent!.score_current).toBe(result.score_r);
    expect(agent!.status).toBe('active');
  });

  test('a confirmed drain crashes the score and gates the agent in the DB', async () => {
    const { agentId, roundId } = await seedRoundAgent('drainer');
    await insertOutcome(db, {
      agent_id: agentId,
      round_id: roundId,
      pnl_realized: '0',
      capital_at_risk: '50000',
    });
    await addPolicyEvent(agentId, roundId, {
      rule_fired: 'fresh_wallet_transfer_block',
      decision: 'REJECT',
      severity: 'hard',
    });

    const inputs = deriveScoreInputs(
      await listOutcomesByAgentRound(db, agentId, roundId),
      await listPolicyEventsByAgentRound(db, agentId, roundId),
    );
    expect(inputs.drain_r).toBe(true);

    const { result } = await recordScore({ db, agentId, roundId, inputs, prevScore: 95 });
    expect(result.crashed).toBe(true);
    expect(Number(result.score_r)).toBeLessThanOrEqual(CONFIG.scoring.crash_cap);

    const agent = await getAgent(db, agentId);
    expect(agent!.status).toBe('gated');
    expect(Number(agent!.score_current)).toBeLessThanOrEqual(CONFIG.scoring.crash_cap);
  });

  test('a multi-round EWMA chain reads its own prior from the DB each round', async () => {
    const agent = await insertAgent(db, {
      display_name: 'ewma-chain',
      owner: 'ops',
      strategy_kind: 'seed',
    });

    let manualPrev = CONFIG.scoring.score_0;
    const scoresSeen: number[] = [];
    for (let r = 0; r < 4; r += 1) {
      const round = await insertRound(db, { index: nextIndex() });
      await insertOutcome(db, {
        agent_id: agent.id,
        round_id: round.id,
        pnl_realized: '900',
        capital_at_risk: '40000',
        drawdown: '0.02',
      });
      const inputs = deriveScoreInputs(
        await listOutcomesByAgentRound(db, agent.id, round.id),
        await listPolicyEventsByAgentRound(db, agent.id, round.id),
      );
      // recordScore reads the prior from the latest persisted row (no prevScore).
      const { result } = await recordScore({ db, agentId: agent.id, roundId: round.id, inputs });

      // Cross-check against a manual EWMA recursion off the same inputs.
      const manual =
        CONFIG.scoring.alpha * Number(result.raw_r) + (1 - CONFIG.scoring.alpha) * manualPrev;
      expect(Number(result.score_r)).toBeCloseTo(manual, 2);
      manualPrev = Number(result.score_r);
      scoresSeen.push(manualPrev);
    }

    // A steady clean, profitable agent climbs monotonically toward its raw level.
    for (let i = 1; i < scoresSeen.length; i += 1) {
      expect(scoresSeen[i]!).toBeGreaterThan(scoresSeen[i - 1]!);
    }
    const history = await listScoreHistoryByAgent(db, agent.id);
    expect(history).toHaveLength(4);
  });
});
