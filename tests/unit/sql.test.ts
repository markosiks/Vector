import { describe, expect, test } from 'bun:test';

import { assertIdent, buildInsert } from '@/lib/db/sql';

describe('assertIdent', () => {
  test('accepts plain snake_case identifiers', () => {
    for (const ok of ['agents', 'capital_allocations', '_x', 'a1_b2']) {
      expect(assertIdent(ok)).toBe(ok);
    }
  });

  test('rejects anything that could break out of an identifier', () => {
    for (const bad of [
      'agents; DROP TABLE x',
      'a b',
      '1agents',
      'Agents',
      'a-b',
      '"a"',
      'a.b',
      '',
      'a)',
    ]) {
      expect(() => assertIdent(bad)).toThrow();
    }
  });
});

describe('buildInsert', () => {
  test('binds every value as a positional parameter, never inline', () => {
    const { text, params } = buildInsert('agents', {
      display_name: "Robert'); DROP TABLE agents;--",
      owner: 'ops',
    });
    expect(text).toBe('INSERT INTO agents (display_name, owner) VALUES ($1, $2) RETURNING *');
    expect(params).toEqual(["Robert'); DROP TABLE agents;--", 'ops']);
    // The dangerous string must appear only in params, never in the SQL text.
    expect(text).not.toContain('DROP TABLE');
  });

  test('skips undefined (keeps DB default) but passes null through as SQL NULL', () => {
    const { text, params } = buildInsert('intents', {
      action: 'open',
      market: null,
      side: undefined,
    });
    expect(text).toBe('INSERT INTO intents (action, market) VALUES ($1, $2) RETURNING *');
    expect(params).toEqual(['open', null]);
  });

  test('throws when no columns remain to insert', () => {
    expect(() => buildInsert('agents', { a: undefined })).toThrow(/no columns/);
  });

  test('rejects an unsafe table name', () => {
    expect(() => buildInsert('agents; DROP', { a: 1 })).toThrow(/unsafe SQL identifier/);
  });

  test('rejects an unsafe column name', () => {
    expect(() => buildInsert('agents', { 'a; DROP': 1 })).toThrow(/unsafe SQL identifier/);
  });
});
