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

  test('appends ON CONFLICT (...) DO NOTHING before RETURNING for a reservation', () => {
    const { text, params } = buildInsert(
      'intents',
      { agent_id: 'a', nonce: '1', action: 'open' },
      { onConflictDoNothing: ['agent_id', 'nonce'] },
    );
    expect(text).toBe(
      'INSERT INTO intents (agent_id, nonce, action) VALUES ($1, $2, $3) ' +
        'ON CONFLICT (agent_id, nonce) DO NOTHING RETURNING *',
    );
    expect(params).toEqual(['a', '1', 'open']);
  });

  test('validates conflict-target identifiers like every other name', () => {
    expect(() =>
      buildInsert('intents', { a: 1 }, { onConflictDoNothing: ['agent_id; DROP'] }),
    ).toThrow(/unsafe SQL identifier/);
  });

  test('rejects an empty conflict target rather than emitting invalid SQL', () => {
    expect(() => buildInsert('intents', { a: 1 }, { onConflictDoNothing: [] })).toThrow(
      /at least one column/,
    );
  });
});
