/**
 * Public types for the Nansen smart-money signal (P2.2, §7.6).
 *
 * Vector consumes Nansen as a *read-only* hint placed in an agent's decision
 * `context.signals.nansen` (boundary: read-only into `context`, never into
 * execution — see `lib/intent/types.ts`). These types describe the normalized
 * shape that crosses that boundary; the wire shape Nansen returns is parsed and
 * narrowed to this in `./client`.
 *
 * The signal is intentionally *small and value-only* — a frozen snapshot of net
 * smart-money flow — so it can be embedded in `context` and serialized without
 * dragging in transport, credentials, or vendor pagination details.
 */

/** One token's net smart-money flow, normalized from a Nansen netflows row. */
export interface NansenNetflow {
  /** Chain the token lives on (e.g. `ethereum`), when the row carries it. */
  readonly chain?: string;
  /** Token contract address, when present (lower-cased as received). */
  readonly tokenAddress?: string;
  /** Token symbol, when present. */
  readonly symbol?: string;
  /**
   * Net USD flow over the window, as a *finite numeric string* exactly as the
   * API reported it (no float round-trip). Positive = net buying by smart money.
   */
  readonly netflowUsd: string;
}

/**
 * A normalized Nansen smart-money snapshot — the value placed in
 * `context.signals.nansen`.
 *
 * It is a frozen, self-describing record: which endpoint produced it and the
 * wall-clock instant it was fetched (so a consumer can reason about staleness).
 * `fetchedAtMs` is real wall-clock time and therefore *non-deterministic*; this
 * is why the live signal is opt-in and off by default in the deterministic arc.
 */
export interface NansenSignal {
  /** Discriminator for the signal source. */
  readonly source: 'nansen';
  /** The Nansen endpoint path this snapshot came from (no host, no secrets). */
  readonly endpoint: string;
  /** Wall-clock instant the snapshot was fetched (ms since epoch). */
  readonly fetchedAtMs: number;
  /** Net smart-money flows, capped to a bounded number of rows. */
  readonly netflows: readonly NansenNetflow[];
}

/**
 * A read-only smart-money signal source the orchestrator polls per tick.
 *
 * The contract is built around one hard invariant — **the tick never blocks on
 * the network**:
 *  - {@link current} is synchronous, never throws, and returns the last known
 *    snapshot (or `undefined` before the first successful fetch). It is the only
 *    method on the agent's hot path.
 *  - {@link maybeRefresh} is fire-and-forget: it *may* kick off a background
 *    fetch on its own slow cadence, but it returns immediately and the caller
 *    must never `await` it. Errors, timeouts, and rate-limits are swallowed
 *    inside the provider (fail-open), leaving the last good snapshot in place.
 */
export interface NansenSignalProvider {
  /**
   * The last successfully-fetched snapshot, or `undefined` if none yet. Pure,
   * synchronous, and total: it never throws and never performs I/O.
   */
  current(): NansenSignal | undefined;
  /**
   * Signal that tick `tickIndex` has begun. The provider decides — on its slow
   * cadence and TTL — whether to start a background refresh. Returns
   * immediately; any fetch runs detached and never affects the tick.
   */
  maybeRefresh(tickIndex: number): void;
}

/** Observability event emitted by the provider. Never carries secrets or bodies. */
export type NansenCallEvent =
  | { readonly type: 'fetch_start'; readonly endpoint: string; readonly calls: number }
  | {
      readonly type: 'fetch_success';
      readonly endpoint: string;
      readonly calls: number;
      readonly rows: number;
    }
  | {
      readonly type: 'fetch_error';
      readonly endpoint: string;
      readonly calls: number;
      readonly reason: string;
    }
  | { readonly type: 'budget_exhausted'; readonly endpoint: string; readonly calls: number };

/** Sink for {@link NansenCallEvent}s (credit/usage accounting). Must not log secrets. */
export type NansenLogger = (event: NansenCallEvent) => void;
