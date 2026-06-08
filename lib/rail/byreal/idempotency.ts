import type { RailFill } from '@/lib/replay/rail';

/**
 * Idempotency guard for the Byreal rail (P2.1).
 *
 * The rail must never place two live orders for the same Intent — a retry, a
 * settlement re-run, or a duplicate delivery must reuse the first fill, not
 * double the position. The Intent's `intent_hash` is the stable, unique key
 * (one canonical signed Intent ⇒ one hash), so a fill is cached under it and a
 * repeat lookup short-circuits before any CLI call.
 *
 * The store is injectable. The default is process-local (sufficient for a single
 * arc run); a deployment that needs durable cross-process idempotency supplies a
 * store backed by the unique `executions.rail_order_id` (see `docs/byreal-rail.md`).
 */
export interface IdempotencyStore {
  /** The fill previously recorded for `intentHash`, or `undefined`. */
  get(intentHash: string): RailFill | undefined | Promise<RailFill | undefined>;
  /** Record `fill` as the settlement of `intentHash`. */
  set(intentHash: string, fill: RailFill): void | Promise<void>;
}

/** A process-local {@link IdempotencyStore} backed by a `Map`. */
export function createMemoryIdempotencyStore(): IdempotencyStore {
  const byHash = new Map<string, RailFill>();
  return {
    get: (intentHash) => byHash.get(intentHash),
    set: (intentHash, fill) => {
      byHash.set(intentHash, fill);
    },
  };
}
