import { describe, expect, test } from 'bun:test';

import { runArc } from '@/lib/replay';
import type { Queryable } from '@/lib/db/types';
import { buildDemoArc } from '@/seed';

/**
 * Unit: `runArc` enforces its single-connection contract (orchestrator
 * "Concurrency" note). The per-round settle wraps score + route in one
 * `BEGIN…COMMIT`, which is only atomic on a dedicated connection. The shared
 * Neon `Pool` also structurally satisfies `Queryable` but spreads each `.query`
 * across arbitrary pooled sockets, so the "transaction" would silently not be
 * one — admitting a non-conserving partial settle. `runArc` must refuse the
 * bare pool *before* doing any work, distinguishing it from a pooled client by
 * the absence of `release`.
 */

const arc = buildDemoArc({ rounds: 2 });

/** A `query` that fails if ever called — the guard must reject before any I/O. */
const explodingQuery: Queryable['query'] = () => {
  throw new Error('query must not run: the connection should be rejected first');
};

describe('runArc single-connection guard', () => {
  test('rejects the shared pool (has connect, lacks release) before touching the db', async () => {
    const poolLike = { query: explodingQuery, connect: () => undefined } as unknown as Queryable;
    await expect(runArc(poolLike, arc)).rejects.toThrow(TypeError);
  });

  test('does not reject a pooled client (exposes release) at the guard', async () => {
    // A client-shaped object passes the guard, so the *next* thing runArc does is
    // query — proven here by the explode reaching us as a plain Error, not the
    // guard's TypeError. (A real run is covered by the Neon integration test.)
    const clientLike = {
      query: explodingQuery,
      connect: () => undefined,
      release: () => undefined,
    } as unknown as Queryable;
    await expect(runArc(clientLike, arc)).rejects.not.toThrow(TypeError);
  });

  test('does not reject a plain query-only fake (neither connect nor release)', async () => {
    const fake = { query: explodingQuery } as unknown as Queryable;
    await expect(runArc(fake, arc)).rejects.not.toThrow(TypeError);
  });
});
