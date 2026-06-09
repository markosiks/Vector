import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { score } from '@/lib/scoring/score';
import type { ScoreInputs, ScoreResult } from '@/lib/scoring/types';
import golden from '@/tests/fixtures/scoring-golden.json';

/**
 * Golden / regression table (§6 artifact). Each row pins a curated input → the
 * exact `{ raw_r, score_r, crashed, components }`. Any change to a formula, a
 * constant, the rounding scale, or the float pipeline that would alter a stored
 * score fails here loudly. Regenerate intentionally (and review the diff) — do
 * not silently re-bless. Covers: clean/profitable, wash-like zero-RoC at small
 * vs large capital, the Sybil split pair, a dominating hard, halt/drain crashes,
 * high drawdown, tanh saturation both signs, and the ~0-capital division guard.
 */

interface GoldenRow {
  readonly name: string;
  readonly inputs: ScoreInputs;
  readonly prev: number;
  readonly expected: ScoreResult;
}

const rows = golden as readonly GoldenRow[];

describe('scoring golden table', () => {
  test('the table is non-empty and every name is unique', () => {
    expect(rows.length).toBeGreaterThan(10);
    expect(new Set(rows.map((r) => r.name)).size).toBe(rows.length);
  });

  for (const r of rows) {
    test(`${r.name} reproduces its pinned output`, () => {
      expect(score(r.inputs, r.prev, CONFIG.scoring)).toEqual(r.expected);
    });
  }

  test('the Sybil pair confirms a split clone scores below the consolidated agent', () => {
    const whole = rows.find((r) => r.name === 'sybil_whole');
    const part = rows.find((r) => r.name === 'sybil_split_each');
    expect(whole && part).toBeTruthy();
    expect(Number(part!.expected.raw_r)).toBeLessThan(Number(whole!.expected.raw_r));
  });
});
