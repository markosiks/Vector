import 'server-only';

import { CONFIG } from '@/lib/config/constants';
import { ENV } from '@/lib/config/env';

import { createNansenClient } from './client';
import { createNansenSignalProvider } from './provider';
import type { NansenLogger, NansenSignalProvider } from './types';

/**
 * Sole-custody loader for the Nansen signal (P2.2). The `server-only` import
 * makes it a build error to pull this module — and the API key it reads — into a
 * client bundle. This is the *only* place `NANSEN_API_KEY` is read; the value
 * flows into the client's request header and nowhere else (never a response
 * DTO, an agent's `context`, a log line, or an `executions` payload).
 *
 * Returns `null` when the signal is **disabled** (no key configured) — the
 * normal, safe default. Wiring a `null` provider into `runArc` is a no-op, so
 * the deterministic arc stays byte-identical until a deployment opts in.
 *
 * Because a live snapshot carries a wall-clock `fetchedAtMs`, enabling the
 * signal makes the arc non-deterministic by construction; it is therefore an
 * explicit, opt-in deployment choice, never the default demo path.
 */
export interface LoadNansenOptions {
  /**
   * Optional credit budget: hard-stop new fetches after this many calls.
   * Omit for unbounded.
   */
  readonly maxCalls?: number;
  /** Optional usage/credit observability sink. Must not log secrets. */
  readonly logger?: NansenLogger;
}

/** Build the configured provider from env + `CONFIG.nansen`, or `null` if disabled. */
export function loadNansenSignalProvider(
  options: LoadNansenOptions = {},
): NansenSignalProvider | null {
  const apiKey = ENV.NANSEN_API_KEY;
  if (apiKey === undefined) return null;

  const client = createNansenClient({
    apiKey,
    endpoint: CONFIG.nansen.endpoint,
  });
  return createNansenSignalProvider({
    client,
    pollEveryNTicks: CONFIG.nansen.poll_every_n_ticks,
    cacheTtlMs: CONFIG.nansen.cache_ttl_ms,
    ...(options.maxCalls === undefined ? {} : { maxCalls: options.maxCalls }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}
