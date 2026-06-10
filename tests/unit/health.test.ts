import { describe, expect, test } from 'bun:test';

import { buildHealthPayload, healthStatusCode } from '@/lib/health';

describe('buildHealthPayload', () => {
  test('maps an up database to ok=true', () => {
    expect(buildHealthPayload({ db: 'up', commit: 'abc123' })).toEqual({
      ok: true,
      db: 'up',
      config_loaded: true,
      commit: 'abc123',
    });
  });

  test('maps a down database to ok=false', () => {
    const payload = buildHealthPayload({ db: 'down', commit: 'abc123' });
    expect(payload.ok).toBe(false);
    expect(payload.db).toBe('down');
  });

  test('normalizes a missing commit to "unknown"', () => {
    expect(buildHealthPayload({ db: 'up', commit: undefined }).commit).toBe('unknown');
    expect(buildHealthPayload({ db: 'up', commit: '   ' }).commit).toBe('unknown');
    expect(buildHealthPayload({ db: 'up', commit: '' }).commit).toBe('unknown');
  });

  test('trims a surrounding-whitespace commit', () => {
    expect(buildHealthPayload({ db: 'up', commit: '  deadbeef  ' }).commit).toBe('deadbeef');
  });

  test('honors an explicit configLoaded=false', () => {
    expect(buildHealthPayload({ db: 'up', commit: 'x', configLoaded: false }).config_loaded).toBe(
      false,
    );
  });
});

describe('healthStatusCode', () => {
  test('returns 200 when up and 503 when down', () => {
    expect(healthStatusCode('up')).toBe(200);
    expect(healthStatusCode('down')).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// Regression tests for audit finding C-06
// ---------------------------------------------------------------------------

describe('buildHealthPayload — C-06: configLoaded is meaningful', () => {
  test('defaults to true when configLoaded is omitted', () => {
    expect(buildHealthPayload({ db: 'up', commit: 'abc' }).config_loaded).toBe(true);
  });

  test('reports false when configLoaded is explicitly false', () => {
    expect(
      buildHealthPayload({ db: 'up', commit: 'abc', configLoaded: false }).config_loaded,
    ).toBe(false);
  });

  test('reports true even when db is down (config and db are independent)', () => {
    expect(
      buildHealthPayload({ db: 'down', commit: 'abc', configLoaded: true }).config_loaded,
    ).toBe(true);
  });
});
