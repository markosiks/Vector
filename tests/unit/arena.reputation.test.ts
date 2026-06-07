import { describe, expect, test } from 'bun:test';

import { deriveScoreChanges } from '@/lib/arena/reputation';
import type { AgentSnapshot } from '@/lib/arena/types';

const CRASH_CAP = 7;

const snap = (
  id: string,
  score: string,
  status: AgentSnapshot['status'] = 'active',
): AgentSnapshot => ({ id, status, score_current: score, allocation: null });

describe('deriveScoreChanges', () => {
  test('reports signed score delta over the 0–100 range', () => {
    const changes = deriveScoreChanges([snap('a', '80')], [snap('a', '60')], CRASH_CAP);
    expect(changes[0]!.deltaFraction).toBeCloseTo(-0.2, 10);
    expect(changes[0]!.prevScore).toBe('80');
    expect(changes[0]!.nextScore).toBe('60');
    expect(changes[0]!.isCrash).toBe(false);
  });

  test('flags a crash when the score crosses down to the floor-crash cap', () => {
    const changes = deriveScoreChanges([snap('a', '73')], [snap('a', '7')], CRASH_CAP);
    expect(changes[0]!.isCrash).toBe(true);
  });

  test('does not re-flag a crash on the poll after it already crashed', () => {
    // Already at/below the cap last poll → not a *new* crossing this poll.
    const changes = deriveScoreChanges([snap('a', '7')], [snap('a', '7')], CRASH_CAP);
    expect(changes[0]!.isCrash).toBe(false);
  });

  test('flags a crash on a status flip out of active even without a score cross', () => {
    const changes = deriveScoreChanges(
      [snap('a', '80', 'active')],
      [snap('a', '80', 'gated')],
      CRASH_CAP,
    );
    expect(changes[0]!.isCrash).toBe(true);
  });

  test('a routine drop above the cap is not a crash', () => {
    const changes = deriveScoreChanges([snap('a', '90')], [snap('a', '40')], CRASH_CAP);
    expect(changes[0]!.isCrash).toBe(false);
  });

  test('only reports agents present in both polls', () => {
    const changes = deriveScoreChanges(
      [snap('a', '50')],
      [snap('a', '50'), snap('new', '95')],
      CRASH_CAP,
    );
    expect(changes.map((c) => c.agentId)).toEqual(['a']);
  });

  test('uses exact decimal comparison at the cap boundary', () => {
    // 7.0000000000000001 is just above the cap; a float compare could miss it.
    const changes = deriveScoreChanges(
      [snap('a', '50')],
      [snap('a', '7.0000000000000001')],
      CRASH_CAP,
    );
    expect(changes[0]!.isCrash).toBe(false);
  });
});
