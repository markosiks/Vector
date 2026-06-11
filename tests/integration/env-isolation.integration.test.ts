import { describe, expect, test } from 'bun:test';

/**
 * Regression guard for cross-file env leaks (the bug class fixed for e2e in
 * PR #44 and for this suite alongside this test).
 *
 * Under `bun test` every file in the run shares one process and Bun evaluates
 * all files' top-level code in a single collection pass before any hook runs.
 * A file that writes a placeholder `DATABASE_URL` at top level (rather than
 * inside `beforeAll`/`afterAll`) leaks it into the collection-time env of every
 * file collected after it, flipping their `hasDb` consts to true. Those suites
 * then connect to a placeholder Postgres and fail instead of skipping.
 *
 * This file sorts after `chain.integration.test.ts` (the historical offender),
 * so the value captured below is exactly what a later-collected peer's `hasDb`
 * gate would see.
 */
const collectionTimeDbUrl = process.env.DATABASE_URL;

describe('integration suite env isolation', () => {
  test('no earlier-collected file leaks a placeholder DATABASE_URL', () => {
    if (collectionTimeDbUrl !== undefined) {
      expect(collectionTimeDbUrl).not.toContain('placeholder');
    }
  });
});
