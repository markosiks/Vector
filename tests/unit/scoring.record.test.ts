import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { updateAgentScore } from '@/lib/db/repos/agents';
import type { OutcomeRow, PolicyEventRow } from '@/lib/db/schema';
import type { Queryable } from '@/lib/db/types';
import { deriveScoreInputs, recordScore } from '@/lib/scoring/record';

/**
 * Unit coverage for the persistence layer that wraps the pure scorer:
 * `deriveScoreInputs` (outcomes + policy_events → aggregated inputs) and
 * `recordScore` (score → insert `scores` → update the `agents` cache/status),
 * exercised against an in-memory `Queryable` so no DB is required.
 */

const AGENT = '11111111-1111-1111-1111-111111111111';
const ROUND = '22222222-2222-2222-2222-222222222222';

function outcome(over: Partial<OutcomeRow>): OutcomeRow {
  return {
    id: crypto.randomUUID(),
    execution_id: null,
    agent_id: AGENT,
    round_id: ROUND,
    pnl_realized: '0',
    pnl_marked: '0',
    capital_at_risk: '0',
    fees: '0',
    position_delta: '0',
    drawdown: '0',
    created_at: new Date(),
    ...over,
  };
}

function event(over: Partial<PolicyEventRow>): PolicyEventRow {
  return {
    id: crypto.randomUUID(),
    intent_id: crypto.randomUUID(),
    agent_id: AGENT,
    round_id: ROUND,
    rule_fired: 'size_cap',
    decision: 'CLIP',
    severity: 'soft',
    detail_json: null,
    created_at: new Date(),
    ...over,
  };
}

describe('deriveScoreInputs', () => {
  test('sums pnl and car, takes max drawdown, counts severities, flags drain', () => {
    const outcomes = [
      outcome({ pnl_realized: '100', pnl_marked: '50', capital_at_risk: '1000', drawdown: '0.1' }),
      outcome({ pnl_realized: '-30', pnl_marked: '0', capital_at_risk: '2000', drawdown: '0.4' }),
    ];
    const events = [
      event({ severity: 'soft' }),
      event({ severity: 'soft' }),
      event({ severity: 'hard', rule_fired: 'market_whitelist', decision: 'REJECT' }),
      event({ severity: 'hard', rule_fired: 'fresh_wallet_transfer_block', decision: 'REJECT' }),
    ];
    const inputs = deriveScoreInputs(outcomes, events);
    expect(inputs).toEqual({
      pnl_r: 120, // 100+50-30+0
      car_r: 3000,
      soft: 2,
      hard: 2,
      halt: 0,
      dd_r: 0.4, // max, not sum
      drain_r: true, // rule #3 fired
    });
  });

  test('no events and no outcomes derive a clean, zero round', () => {
    expect(deriveScoreInputs([], [])).toEqual({
      pnl_r: 0,
      car_r: 0,
      soft: 0,
      hard: 0,
      halt: 0,
      dd_r: 0,
      drain_r: false,
    });
  });

  test('volume/trade-count invariance: many tiny outcomes equal one aggregate', () => {
    const big = deriveScoreInputs([outcome({ pnl_realized: '100', capital_at_risk: '10000' })], []);
    const split = deriveScoreInputs(
      Array.from({ length: 100 }, () => outcome({ pnl_realized: '1', capital_at_risk: '100' })),
      [],
    );
    expect(split).toEqual(big);
  });
});

/** Minimal fake routing by SQL verb/table; records the UPDATE bind params. */
class FakeDb implements Queryable {
  public updateParams: readonly unknown[] | undefined;
  constructor(private readonly latestScoreRows: Record<string, unknown>[]) {}
  async query<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    if (sql.startsWith('SELECT * FROM scores')) {
      return { rows: this.latestScoreRows as R[], rowCount: this.latestScoreRows.length };
    }
    if (sql.startsWith('INSERT INTO scores')) {
      const row = {
        id: crypto.randomUUID(),
        agent_id: AGENT,
        round_id: ROUND,
        raw_r: String(params?.[2]),
        score_r: String(params?.[3]),
        components_json: params?.[4] ?? null,
        created_at: new Date(),
      };
      return { rows: [row] as R[], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE agents')) {
      this.updateParams = params;
      const row = {
        id: AGENT,
        agent_id_onchain: null,
        display_name: 'a',
        owner: 'ops',
        strategy_kind: 'seed',
        status: params?.[2] ? 'gated' : 'active',
        score_current: String(params?.[1]),
        created_at: new Date(),
      };
      return { rows: [row] as R[], rowCount: 1 };
    }
    throw new Error(`unexpected sql: ${sql}`);
  }
}

describe('recordScore', () => {
  test('seeds the EWMA with score_0 when the agent has never been scored', async () => {
    const db = new FakeDb([]); // no prior scores
    const { result, row } = await recordScore({
      db,
      agentId: AGENT,
      roundId: ROUND,
      inputs: { pnl_r: 500, car_r: 10_000, soft: 0, hard: 0, halt: 0, dd_r: 0, drain_r: false },
    });
    // EWMA against the score_0 prior, not the DB default of 0.
    expect(Number(result.score_r)).toBeCloseTo(
      CONFIG.scoring.alpha * Number(result.raw_r) +
        (1 - CONFIG.scoring.alpha) * CONFIG.scoring.score_0,
      3,
    );
    expect(row.components_json).toEqual(result.components);
  });

  test('uses the latest persisted score as the prior when one exists', async () => {
    const db = new FakeDb([{ ...latestRow('80.000') }]);
    const { result } = await recordScore({
      db,
      agentId: AGENT,
      roundId: ROUND,
      inputs: { pnl_r: 500, car_r: 10_000, soft: 0, hard: 0, halt: 0, dd_r: 0, drain_r: false },
    });
    expect(Number(result.score_r)).toBeCloseTo(
      CONFIG.scoring.alpha * Number(result.raw_r) + (1 - CONFIG.scoring.alpha) * 80,
      3,
    );
  });

  test('a floor-crash gates the agent', async () => {
    const db = new FakeDb([]);
    const { result, agent } = await recordScore({
      db,
      agentId: AGENT,
      roundId: ROUND,
      inputs: { pnl_r: 0, car_r: 50_000, soft: 0, hard: 0, halt: 1, dd_r: 0, drain_r: false },
    });
    expect(result.crashed).toBe(true);
    expect(db.updateParams?.[2]).toBe(true); // gated flag
    expect(agent.status).toBe('gated');
  });

  test('a score below s_min gates even without a crash', async () => {
    const db = new FakeDb([]);
    // Tiny capital, negative pnl ⇒ low raw ⇒ EWMA below s_min=30 from score_0=20.
    const { result, agent } = await recordScore({
      db,
      agentId: AGENT,
      roundId: ROUND,
      inputs: { pnl_r: -100, car_r: 10, soft: 0, hard: 0, halt: 0, dd_r: 0, drain_r: false },
    });
    expect(result.crashed).toBe(false);
    expect(Number(result.score_r)).toBeLessThan(CONFIG.router.s_min);
    expect(agent.status).toBe('gated');
  });

  test('a healthy score above s_min keeps the agent active', async () => {
    const db = new FakeDb([{ ...latestRow('90.000') }]);
    const { agent } = await recordScore({
      db,
      agentId: AGENT,
      roundId: ROUND,
      inputs: { pnl_r: 5_000, car_r: 90_000, soft: 0, hard: 0, halt: 0, dd_r: 0, drain_r: false },
    });
    expect(agent.status).toBe('active');
  });
});

describe('updateAgentScore', () => {
  test('binds the gating flag and the score, and parses the returned row', async () => {
    const db = new FakeDb([]);
    const agent = await updateAgentScore(db, AGENT, { score_current: '42.500', gated: true });
    expect(db.updateParams).toEqual([AGENT, '42.500', true]);
    expect(agent.status).toBe('gated');
    expect(agent.score_current).toBe('42.500');
  });

  test('throws when no agent matches the id', async () => {
    const empty: Queryable = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
    };
    await expect(
      updateAgentScore(empty, AGENT, { score_current: 10, gated: false }),
    ).rejects.toThrow(/no agent with id/);
  });
});

function latestRow(scoreR: string): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    agent_id: AGENT,
    round_id: '00000000-0000-0000-0000-000000000000',
    raw_r: '0.00000000',
    score_r: scoreR,
    components_json: null,
    created_at: new Date(),
  };
}
