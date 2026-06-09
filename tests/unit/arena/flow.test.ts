import { describe, expect, test } from 'bun:test';

import { deriveFlows, pairFlows } from '@/lib/arena/flow';
import type { AgentSnapshot } from '@/lib/arena/types';

const POOL = 1_000_000;

const snap = (id: string, allocation: string | null): AgentSnapshot => ({
  id,
  status: 'active',
  score_current: '50',
  allocation,
});

describe('deriveFlows', () => {
  test('reports signed per-agent change as a fraction of the pool', () => {
    const prev = [snap('a', '600000'), snap('b', '400000')];
    const next = [snap('a', '350000'), snap('b', '650000')];
    const flows = deriveFlows(prev, next, POOL);
    expect(flows).toEqual([
      { agentId: 'a', direction: 'out', deltaFraction: -0.25 },
      { agentId: 'b', direction: 'in', deltaFraction: 0.25 },
    ]);
  });

  test('treats absent ↔ funded transitions as flows', () => {
    const prev = [snap('a', '1000000'), snap('b', null)];
    const next = [snap('a', null), snap('b', '1000000')];
    const flows = deriveFlows(prev, next, POOL);
    expect(flows).toEqual([
      { agentId: 'a', direction: 'out', deltaFraction: -1 },
      { agentId: 'b', direction: 'in', deltaFraction: 1 },
    ]);
  });

  test('includes agents present in only one snapshot (union of ids)', () => {
    const flows = deriveFlows([snap('a', '500000')], [snap('b', '500000')], POOL);
    expect(flows.map((f) => f.agentId).sort()).toEqual(['a', 'b']);
  });

  test('sub-epsilon and zero changes are direction "none"', () => {
    const flows = deriveFlows([snap('a', '500000')], [snap('a', '500000')], POOL);
    expect(flows[0]!.direction).toBe('none');
  });

  test('pool ≤ 0 or non-finite → all none, never divides by zero', () => {
    const flows = deriveFlows([snap('a', '0')], [snap('a', '500000')], 0);
    expect(flows[0]).toEqual({ agentId: 'a', direction: 'none', deltaFraction: 0 });
  });

  test('malformed allocation strings are treated as 0, not NaN', () => {
    const flows = deriveFlows([snap('a', 'not-a-number')], [snap('a', '250000')], POOL);
    expect(flows[0]!.deltaFraction).toBeCloseTo(0.25, 10);
    expect(Number.isNaN(flows[0]!.deltaFraction)).toBe(false);
  });
});

describe('pairFlows', () => {
  test('pairs the dominant loser with the dominant gainer (leader → runner-up)', () => {
    const flows = deriveFlows(
      [snap('leader', '600000'), snap('rup', '400000')],
      [snap('leader', '350000'), snap('rup', '650000')],
      POOL,
    );
    expect(pairFlows(flows)).toEqual([{ fromAgentId: 'leader', toAgentId: 'rup', fraction: 0.25 }]);
  });

  test('splits one large outflow across several inflows, largest first', () => {
    const flows = deriveFlows(
      [snap('a', '900000'), snap('b', '50000'), snap('c', '50000')],
      [snap('a', '300000'), snap('b', '450000'), snap('c', '250000')],
      POOL,
    );
    const arcs = pairFlows(flows);
    // Geometry fractions accumulate float drift across the greedy subtraction;
    // the routing (who → whom) is exact, the magnitude is checked approximately.
    expect(arcs[0]!.fromAgentId).toBe('a');
    expect(arcs[0]!.toAgentId).toBe('b');
    expect(arcs[0]!.fraction).toBeCloseTo(0.4, 10);
    expect(arcs[1]!.fromAgentId).toBe('a');
    expect(arcs[1]!.toAgentId).toBe('c');
    expect(arcs[1]!.fraction).toBeCloseTo(0.2, 10);
  });

  test('bounds the number of arcs', () => {
    const prev = Array.from({ length: 10 }, (_, i) => snap(`p${i}`, '100000'));
    const next = prev.map((s, i) =>
      i === 0 ? snap('p0', '0') : snap(s.id, String(100000 + 11111)),
    );
    const arcs = pairFlows(deriveFlows(prev, next, POOL), 2);
    expect(arcs.length).toBeLessThanOrEqual(2);
  });

  test('no opposing side → no arcs', () => {
    const flows = deriveFlows([snap('a', '100000')], [snap('a', '200000')], POOL);
    expect(pairFlows(flows)).toEqual([]);
  });
});
