import { describe, expect, test } from 'bun:test';

import { detectRankChanges, rankAgents } from '@/lib/arena/rank';
import { makeAgent } from '../fixtures/arena-fixtures';

const POOL = 1_000_000;

describe('rankAgents', () => {
  test('orders by score DESC and assigns zero-based ranks', () => {
    const ranked = rankAgents(
      [
        makeAgent({ id: 'a', score_current: '40' }),
        makeAgent({ id: 'b', score_current: '90' }),
        makeAgent({ id: 'c', score_current: '70' }),
      ],
      POOL,
    );
    expect(ranked.map((r) => [r.id, r.rank])).toEqual([
      ['b', 0],
      ['c', 1],
      ['a', 2],
    ]);
  });

  test('breaks score ties by created_at ASC then id ASC — stable across calls', () => {
    const entries = [
      makeAgent({ id: 'z', score_current: '50', created_at: '2026-06-07T12:00:00.000Z' }),
      makeAgent({ id: 'a', score_current: '50', created_at: '2026-06-07T12:00:00.000Z' }),
      makeAgent({ id: 'm', score_current: '50', created_at: '2026-06-07T11:00:00.000Z' }),
    ];
    const first = rankAgents(entries, POOL).map((r) => r.id);
    const second = rankAgents([...entries].reverse(), POOL).map((r) => r.id);
    expect(first).toEqual(['m', 'a', 'z']); // earlier time first, then id asc
    expect(second).toEqual(first); // input order must not change the result
  });

  test('does not mutate the input array', () => {
    const entries = [
      makeAgent({ id: 'a', score_current: '10' }),
      makeAgent({ id: 'b', score_current: '90' }),
    ];
    const snapshot = entries.map((e) => e.id);
    rankAgents(entries, POOL);
    expect(entries.map((e) => e.id)).toEqual(snapshot);
  });

  test('computes geometry fractions; null allocation → 0', () => {
    const [r] = rankAgents([makeAgent({ score_current: '25', allocation: '500000' })], POOL);
    expect(r!.scoreFraction).toBeCloseTo(0.25, 10);
    expect(r!.allocationFraction).toBeCloseTo(0.5, 10);

    const [n] = rankAgents([makeAgent({ score_current: '25', allocation: null })], POOL);
    expect(n!.allocationFraction).toBe(0);
  });

  test('non-finite / zero pool yields 0 allocation fraction, never NaN/Infinity', () => {
    const [r] = rankAgents([makeAgent({ allocation: '500000' })], 0);
    expect(r!.allocationFraction).toBe(0);
  });

  test('empty input yields empty board', () => {
    expect(rankAgents([], POOL)).toEqual([]);
  });
});

describe('detectRankChanges', () => {
  test('reports only agents whose rank moved, with signed delta', () => {
    const prev = rankAgents(
      [makeAgent({ id: 'a', score_current: '90' }), makeAgent({ id: 'b', score_current: '50' })],
      POOL,
    );
    const next = rankAgents(
      [makeAgent({ id: 'a', score_current: '40' }), makeAgent({ id: 'b', score_current: '50' })],
      POOL,
    );
    const changes = detectRankChanges(prev, next);
    expect(changes).toEqual([
      { agentId: 'b', from: 1, to: 0, delta: -1 },
      { agentId: 'a', from: 0, to: 1, delta: 1 },
    ]);
  });

  test('ignores agents that appear or disappear', () => {
    const prev = rankAgents([makeAgent({ id: 'a', score_current: '90' })], POOL);
    const next = rankAgents(
      [makeAgent({ id: 'a', score_current: '90' }), makeAgent({ id: 'new', score_current: '95' })],
      POOL,
    );
    // 'a' fell from 0→1 (new took the lead); 'new' has no prior rank → omitted.
    expect(detectRankChanges(prev, next)).toEqual([{ agentId: 'a', from: 0, to: 1, delta: 1 }]);
  });

  test('no movement → no changes', () => {
    const board = rankAgents([makeAgent({ id: 'a' }), makeAgent({ id: 'b' })], POOL);
    expect(detectRankChanges(board, board)).toEqual([]);
  });
});
