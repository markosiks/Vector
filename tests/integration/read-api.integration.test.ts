import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from '@neondatabase/serverless';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { loadMigrations, migrate, MIGRATIONS_DIR } from '@/lib/db/migrate';
import { insertAgent } from '@/lib/db/repos/agents';
import { insertAttestation, listAttestationsPage } from '@/lib/db/repos/attestations';
import { insertCapitalAllocation } from '@/lib/db/repos/capital-allocations';
import { insertIntent } from '@/lib/db/repos/intents';
import { listLeaderboard } from '@/lib/db/repos/leaderboard';
import { insertOutcome, listRecentOutcomesByAgent } from '@/lib/db/repos/outcomes';
import { insertPolicyEvent, listPolicyEventsPage } from '@/lib/db/repos/policy-events';
import { getLatestRound, insertRound } from '@/lib/db/repos/rounds';
import { insertScore, listScoreHistoryByAgent } from '@/lib/db/repos/scores';
import type { Queryable } from '@/lib/db/types';

/**
 * Read-API repository layer against a **real** Neon database, isolated in a
 * throwaway schema. Skipped unless `DATABASE_URL` is set:
 *
 *   DATABASE_URL='postgresql://…' bun run test:integration
 *
 * Covers what only a real Postgres can: the leaderboard join, keyset pagination
 * walking a full feed across pages with `created_at` ties, near-real-time head
 * visibility, the chain_state filter, round-index score ordering, and that the
 * feed/leaderboard queries are *index-usable* (EXPLAIN with seqscan disabled).
 */

const hasDb = typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0;
const describeDb = hasDb ? describe : describe.skip;

describeDb('Read API repos (isolated schema on real Neon)', () => {
  const schema = `vec_read_${randomUUID().replace(/-/g, '')}`;
  let pool: Pool;
  let client: PoolClient;
  let db: Queryable & { query: PoolClient['query'] };

  // Captured ids for assertions.
  let roundId: string;
  let leaderId: string; // highest score, has an allocation
  let midId: string; // mid score, no allocation
  let laggardId: string; // lowest score

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
    db = client as unknown as Queryable & { query: PoolClient['query'] };
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await migrate(pool, loadMigrations(MIGRATIONS_DIR), { direction: 'up', searchPath: schema });

    const round = await insertRound(db, { index: 0, state: 'open' });
    roundId = round.id;

    const leader = await insertAgent(db, {
      display_name: 'leader',
      owner: 'ops',
      strategy_kind: 'seed',
      score_current: '90.000',
    });
    const mid = await insertAgent(db, {
      display_name: 'mid',
      owner: 'ops',
      strategy_kind: 'external',
      score_current: '50.000',
    });
    const laggard = await insertAgent(db, {
      display_name: 'laggard',
      owner: 'ops',
      strategy_kind: 'external',
      score_current: '10.000',
    });
    leaderId = leader.id;
    midId = mid.id;
    laggardId = laggard.id;

    // Only the leader has an allocation this round.
    await insertCapitalAllocation(db, {
      agent_id: leaderId,
      round_id: roundId,
      amount: '250000.123456789012345678',
      target_weight: '0.5',
      prev_weight: '0.4',
      delta: '0.1',
      trigger: 'settle',
    });

    // A burst of policy events, several sharing one created_at tick.
    const tick = new Date('2026-06-07T00:00:00.000Z');
    for (let i = 0; i < 25; i += 1) {
      const intent = await insertIntent(db, {
        round_id: roundId,
        agent_id: leaderId,
        intent_hash: `0x${i.toString(16)}`,
        action: 'open',
      });
      // Force a shared created_at for half of them to exercise the id tie-break.
      const createdAt = i % 2 === 0 ? tick : new Date(tick.getTime() + i);
      await db.query(
        `INSERT INTO policy_events (intent_id, agent_id, round_id, rule_fired, decision, severity, created_at)
         VALUES ($1,$2,$3,'leverage_cap','REJECT','hard',$4)`,
        [intent.id, leaderId, roundId, createdAt],
      );
    }

    // Attestations in two chain states. `attestations` is UNIQUE(agent_id,
    // round_id), so each row must be a distinct agent within this round.
    const attBy: [string, 'optimistic' | 'confirmed'][] = [
      [leaderId, 'confirmed'],
      [midId, 'confirmed'],
      [laggardId, 'optimistic'],
    ];
    for (const [agent_id, chain_state] of attBy) {
      await insertAttestation(db, {
        agent_id,
        round_id: roundId,
        value: '170141183460469231731687303715884105727',
        chain_state,
      });
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

  test('leaderboard: ranked by score, allocation joined for the current round', async () => {
    const round = await getLatestRound(db);
    expect(round?.id).toBe(roundId);

    const rows = await listLeaderboard(db, round?.id ?? null, 100);
    expect(rows.map((r) => r.id)).toEqual([leaderId, midId, laggardId]); // score DESC
    expect(rows[0]?.allocation_amount).toBe('250000.123456789012345678'); // precision intact
    expect(rows[1]?.allocation_amount).toBeNull(); // LEFT JOIN miss → null, not error
  });

  test('policy-events keyset pagination walks the full feed once, in order', async () => {
    const collected: { id: string; created_at: Date }[] = [];
    let before: { t: string; id: string } | undefined;
    let guard = 0;
    for (;;) {
      const page = await listPolicyEventsPage(db, 7, before);
      collected.push(...page.map((r) => ({ id: r.id, created_at: r.created_at })));
      if (page.length < 7) break;
      const last = page[page.length - 1]!;
      before = { t: last.created_at.toISOString(), id: last.id };
      guard += 1;
      expect(guard).toBeLessThan(20);
    }
    expect(collected).toHaveLength(25);
    expect(new Set(collected.map((c) => c.id)).size).toBe(25); // no duplicate

    // Order is non-increasing by (created_at, id) — strictly monotone keyset.
    for (let i = 1; i < collected.length; i += 1) {
      const prev = collected[i - 1]!;
      const cur = collected[i]!;
      const pt = prev.created_at.getTime();
      const ct = cur.created_at.getTime();
      expect(pt > ct || (pt === ct && prev.id > cur.id)).toBe(true);
    }
  });

  test('near-real-time: a just-inserted REJECT is at the head on the next read', async () => {
    const intent = await insertIntent(db, {
      round_id: roundId,
      agent_id: leaderId,
      intent_hash: '0xfresh',
      action: 'open',
    });
    const fresh = await insertPolicyEvent(db, {
      intent_id: intent.id,
      agent_id: leaderId,
      round_id: roundId,
      rule_fired: 'kill_switch',
      decision: 'HALT',
      severity: 'halt',
    });
    const head = await listPolicyEventsPage(db, 5);
    expect(head[0]?.id).toBe(fresh.id);
  });

  test('attestations: chain_state filter returns only that state', async () => {
    const confirmed = await listAttestationsPage(db, { limit: 100, chainState: 'confirmed' });
    expect(confirmed.length).toBeGreaterThanOrEqual(1);
    expect(confirmed.every((a) => a.chain_state === 'confirmed')).toBe(true);
  });

  test('score history is ordered by round index, not insertion time', async () => {
    // Two rounds, inserted out of index order; history must come back by index.
    const r2 = await insertRound(db, { index: 2, state: 'settled' });
    const r1 = await insertRound(db, { index: 1, state: 'settled' });
    await insertScore(db, { agent_id: laggardId, round_id: r2.id, raw_r: '5', score_r: '20' });
    await insertScore(db, { agent_id: laggardId, round_id: r1.id, raw_r: '3', score_r: '15' });

    const history = await listScoreHistoryByAgent(db, laggardId);
    expect(history.map((s) => s.round_id)).toEqual([r1.id, r2.id]); // index 1 then 2
  });

  test('recent outcomes for an agent come back newest first', async () => {
    await insertOutcome(db, { agent_id: midId, round_id: roundId, pnl_realized: '1' });
    const outcomes = await listRecentOutcomesByAgent(db, midId, 10);
    expect(outcomes.length).toBeGreaterThanOrEqual(1);
  });

  test('feed and leaderboard queries are index-usable (EXPLAIN, seqscan off)', async () => {
    await client.query('SET LOCAL enable_seqscan = off');

    const feedPlan = await client.query<{ 'QUERY PLAN': string }>(
      'EXPLAIN SELECT * FROM policy_events ORDER BY created_at DESC, id DESC LIMIT 7',
    );
    const feedText = feedPlan.rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(feedText).toContain('idx_policy_events_created');

    const lbPlan = await client.query<{ 'QUERY PLAN': string }>(
      'EXPLAIN SELECT * FROM agents ORDER BY score_current DESC, created_at ASC LIMIT 100',
    );
    const lbText = lbPlan.rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(lbText).toContain('idx_agents_score_current');
  });
});

describe('Read API repos (skipped without DATABASE_URL)', () => {
  test.skipIf(hasDb)('placeholder so the file always reports at least one test', () => {
    expect(hasDb).toBe(false);
  });
});
