import 'server-only';

import { CONFIG } from '@/lib/config/constants';
import { ENV } from '@/lib/config/env';

import { createElfaClient } from './client';
import { buildElfaMock } from './mock';
import { createElfaSignalProvider } from './provider';
import type { ElfaLogger, ElfaSignalProvider } from './types';

/**
 * Sole-custody loader for the Elfa signal (P3.1). The `server-only` import makes
 * it a build error to pull this module — and the API key it reads — into a
 * client bundle. This is the *only* place `ELFA_API_KEY` is read; the value flows
 * into the client's request header and nowhere else (never a response DTO, an
 * agent's `context`, a log line, or an `executions` payload).
 *
 * Unlike the Nansen loader, this **never returns `null`**: the Elfa signal is
 * always present by design (§4.2 / Definition of Done). It returns a provider in
 * one of two modes, decided by `CONFIG.elfa.mode` and key presence:
 *
 *  - **live** — `mode === 'real'` *and* `ELFA_API_KEY` is set. The provider polls
 *    the live endpoint on a slow cadence and falls back to the seeded mock on any
 *    failure. A live snapshot carries wall-clock `fetchedAtMs`, so enabling live
 *    mode makes the arc non-deterministic by construction — an explicit opt-in.
 *  - **mock** — every other case (`mode === 'mock'`, or `real` with no key). The
 *    provider is mock-only: it never touches the network and serves the
 *    deterministic seeded snapshot. Because the mock is byte-stable and the seed
 *    strategies ignore `context.signals`, wiring it keeps the arc byte-identical.
 *
 * Wiring the returned provider into `runArc({ elfa })` injects its value into the
 * runner-up's `context.signals.elfa` (see `lib/replay/signals.ts`).
 */
export interface LoadElfaOptions {
  /**
   * Optional credit budget for live mode: hard-stop new fetches after this many
   * calls. Ignored in mock mode (no fetches). Omit for unbounded.
   */
  readonly maxCalls?: number;
  /** Optional usage/credit observability sink. Must not log secrets. */
  readonly logger?: ElfaLogger;
}

/** Build the configured provider from `CONFIG.elfa` + env. Always returns a provider. */
export function loadElfaSignalProvider(options: LoadElfaOptions = {}): ElfaSignalProvider {
  const mock = buildElfaMock();
  const apiKey = ENV.ELFA_API_KEY;
  const wantLive = CONFIG.elfa.mode === 'real' && apiKey !== undefined;

  const client = wantLive
    ? createElfaClient({
        // `wantLive` proves `apiKey` is defined; non-null assert is safer than `as string`.
        apiKey: apiKey!,
        endpoint: CONFIG.elfa.endpoint,
      })
    : undefined;

  return createElfaSignalProvider({
    mock,
    ...(client === undefined ? {} : { client }),
    pollEveryNTicks: CONFIG.elfa.poll_every_n_ticks,
    cacheTtlMs: CONFIG.elfa.cache_ttl_ms,
    ...(options.maxCalls === undefined ? {} : { maxCalls: options.maxCalls }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}
