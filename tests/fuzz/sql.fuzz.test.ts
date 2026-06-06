import { describe, expect, test } from 'bun:test';

import { assertIdent, buildInsert } from '@/lib/db/sql';

/**
 * Fuzz the SQL builder. Invariants under random input:
 *  - assertIdent accepts a string iff it matches the strict snake_case pattern;
 *  - buildInsert never inlines a value (every defined column → one `$n`), and
 *    the parameter list matches the placeholders one-for-one.
 */

const SAFE_RE = /^[a-z_][a-z0-9_]*$/;

function randString(len: number): string {
  const alphabet =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-;\'" .()=*/\\\t\n';
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

describe('assertIdent (fuzz)', () => {
  test('accepts exactly the strings matching the safe pattern', () => {
    for (let i = 0; i < 2000; i += 1) {
      const s = randString(Math.floor(Math.random() * 12));
      const expectOk = SAFE_RE.test(s);
      if (expectOk) {
        expect(assertIdent(s)).toBe(s);
      } else {
        expect(() => assertIdent(s)).toThrow();
      }
    }
  });
});

describe('buildInsert (fuzz)', () => {
  const cols = ['display_name', 'owner', 'market', 'reason', 'tag1'];

  test('always parameterizes values; placeholders match params', () => {
    for (let i = 0; i < 1000; i += 1) {
      const values: Record<string, unknown> = {};
      const defined: string[] = [];
      for (const c of cols) {
        const r = Math.random();
        if (r < 0.33) continue; // omit
        if (r < 0.5) {
          values[c] = null;
        } else {
          values[c] = randString(Math.floor(Math.random() * 30));
        }
        defined.push(c);
      }
      if (defined.length === 0) {
        expect(() => buildInsert('agents', values)).toThrow();
        continue;
      }

      const { text, params } = buildInsert('agents', values);
      // The SQL text is fully determined by the column set — values appear only
      // as positional placeholders, never inlined. Exact-match proves it.
      const expected = `INSERT INTO agents (${defined.join(', ')}) VALUES (${defined
        .map((_, idx) => `$${idx + 1}`)
        .join(', ')}) RETURNING *`;
      expect(text).toBe(expected);
      expect(params).toHaveLength(defined.length);
    }
  });
});
