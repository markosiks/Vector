/**
 * Public types for the Elfa social-sentiment signal (P3.1, §9.3).
 *
 * Vector consumes Elfa as a *read-only* flavor hint placed in the runner-up
 * agent's decision `context.signals.elfa` (boundary: read-only into `context`,
 * never into execution — see `lib/intent/types.ts`). These types describe the
 * normalized shape that crosses that boundary; the wire shape Elfa returns is
 * parsed and narrowed to this in `./client`, and a deterministic stand-in is
 * produced by `./mock`.
 *
 * Unlike the Nansen signal (P2.2), the Elfa signal is **always present**: when
 * no key is configured, the live API errors, or the deployment runs in `mock`
 * mode, the provider serves a deterministic seeded snapshot instead of
 * `undefined`. The {@link ElfaSignal.origin} discriminator marks, transparently,
 * which source produced the value the consumer is reading.
 *
 * The signal is intentionally *small and value-only* — a frozen snapshot of
 * social sentiment per token — so it can be embedded in `context` and serialized
 * without dragging in transport, credentials, or vendor pagination details.
 */

/** One token's social sentiment, normalized from an Elfa row. */
export interface ElfaSentiment {
  /** Token symbol (e.g. `BTC`), when the row carries it. */
  readonly symbol?: string;
  /** Token contract address, when present. */
  readonly tokenAddress?: string;
  /**
   * Sentiment score over the window, as a *finite numeric string* exactly as
   * the API reported it (no float round-trip). Convention: positive = bullish
   * social sentiment, negative = bearish. The range is vendor-defined and not
   * re-scaled here.
   */
  readonly sentiment: string;
  /** Mention count over the window, finite numeric string, when present. */
  readonly mentions?: string;
  /** Mindshare / share-of-voice, finite numeric string, when present. */
  readonly mindshare?: string;
}

/**
 * A normalized Elfa sentiment snapshot — the value placed in
 * `context.signals.elfa`.
 *
 * It is a frozen, self-describing record: which source produced it
 * ({@link origin}), which endpoint, and the wall-clock instant it was fetched.
 *
 * Determinism: a **live** snapshot stamps real `fetchedAtMs` and is therefore
 * non-deterministic, which is why live mode is opt-in. A **mock** snapshot uses
 * a fixed, seeded `fetchedAtMs` so it is byte-stable across runs; embedding it in
 * `context` cannot perturb the deterministic arc (the seed strategies ignore
 * `context.signals` entirely).
 */
export interface ElfaSignal {
  /** Discriminator for the signal source. */
  readonly source: 'elfa';
  /** Whether this snapshot came from the live API (`live`) or the seeded stand-in (`mock`). */
  readonly origin: 'live' | 'mock';
  /** The Elfa endpoint path this snapshot came from (no host, no secrets). */
  readonly endpoint: string;
  /** Instant the snapshot was produced (ms since epoch). Fixed for `mock`. */
  readonly fetchedAtMs: number;
  /** Per-token sentiment rows, capped to a bounded number. */
  readonly sentiments: readonly ElfaSentiment[];
}

/**
 * A read-only sentiment signal source the orchestrator polls per tick.
 *
 * The contract is built around two invariants:
 *  - **The tick never blocks on the network.** {@link current} is synchronous,
 *    never throws, and never does I/O.
 *  - **A value is always available.** Unlike the Nansen provider, {@link current}
 *    never returns `undefined`: before/without a live fetch it returns the seeded
 *    mock, so `context.signals.elfa` is always populated (fail-open to mock).
 *  - {@link maybeRefresh} is fire-and-forget: in live mode it *may* kick off a
 *    background fetch on its own slow cadence; in mock mode it is a no-op. It
 *    returns immediately and the caller must never `await` it. Errors, timeouts,
 *    and rate-limits are swallowed inside the provider, leaving the last good
 *    value (live snapshot or mock) in place.
 */
export interface ElfaSignalProvider {
  /**
   * The current snapshot — the last successful **live** fetch, or the seeded
   * **mock** when no live value exists. Pure, synchronous, total: it never
   * throws and never performs I/O, and never returns `undefined`.
   */
  current(): ElfaSignal;
  /**
   * Signal that tick `tickIndex` has begun. In live mode the provider decides —
   * on its slow cadence and TTL — whether to start a background refresh; in mock
   * mode it does nothing. Returns immediately; any fetch runs detached and never
   * affects the tick.
   */
  maybeRefresh(tickIndex: number): void;
  /** The resolved mode: `live` when a real client is wired, else `mock`. Observability. */
  mode(): 'live' | 'mock';
}

/** Observability event emitted by the provider. Never carries secrets or bodies. */
export type ElfaCallEvent =
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

/** Sink for {@link ElfaCallEvent}s (credit/usage accounting). Must not log secrets. */
export type ElfaLogger = (event: ElfaCallEvent) => void;
