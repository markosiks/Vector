import { describe, expect, test } from 'bun:test';

import {
  ApiError,
  BadRequestError,
  classifyError,
  isDbUnavailable,
  NotFoundError,
} from '@/lib/api/errors';

/** Error classification: client errors echo; everything else stays opaque. */

describe('typed client errors keep their status/code/message', () => {
  test('BadRequestError → 400', () => {
    const c = classifyError(new BadRequestError('bad limit', 'invalid_limit'));
    expect(c.status).toBe(400);
    expect(c.body.error).toEqual({ code: 'invalid_limit', message: 'bad limit' });
  });

  test('NotFoundError → 404', () => {
    const c = classifyError(new NotFoundError('agent not found', 'agent_not_found'));
    expect(c.status).toBe(404);
    expect(c.body.error.code).toBe('agent_not_found');
  });

  test('a custom ApiError status is honored', () => {
    expect(classifyError(new ApiError(418, 'teapot', 'no coffee')).status).toBe(418);
  });
});

describe('isDbUnavailable', () => {
  test.each(['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', '08006', '57P03', '53300'])(
    'recognizes connection error code %p',
    (code) => {
      expect(isDbUnavailable({ code })).toBe(true);
    },
  );

  test.each([{}, null, undefined, new Error('boom'), { code: '23505' }, { code: 42 }])(
    'does not misclassify %p',
    (err) => {
      expect(isDbUnavailable(err)).toBe(false);
    },
  );
});

describe('unexpected throws never leak internals', () => {
  test('a DB outage maps to a generic 503', () => {
    const c = classifyError({ code: 'ECONNREFUSED', message: 'connect to 10.0.0.5:5432 failed' });
    expect(c.status).toBe(503);
    expect(c.body.error.code).toBe('service_unavailable');
    expect(JSON.stringify(c.body)).not.toContain('10.0.0.5');
  });

  test('any other throw maps to a generic 500 with no detail', () => {
    const c = classifyError(new Error('postgresql://user:pass@host/db exploded'));
    expect(c.status).toBe(500);
    expect(c.body.error.code).toBe('internal_error');
    expect(JSON.stringify(c.body)).not.toContain('postgresql://');
    expect(JSON.stringify(c.body)).not.toContain('exploded');
  });

  test('a thrown string does not crash the classifier', () => {
    expect(classifyError('weird').status).toBe(500);
  });
});
