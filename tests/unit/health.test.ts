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
