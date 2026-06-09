/**
 * The Elfa social-sentiment signal (P3.1, §9.3): a read-only hint placed in the
 * runner-up agent's `context.signals.elfa`. A single trending-tokens call,
 * fronted by a TTL cache and slow poller, with a deterministic seeded mock as
 * the always-present fail-open baseline — injected into the runner-up's decision
 * context, never into execution, and never on the tick's critical path. See
 * `docs/elfa-signal.md`.
 *
 * This barrel re-exports only the transport-pure surface (types, client, mock,
 * provider). The `server-only` key loader lives in `./load` and is imported
 * directly by the (server-side) caller that wires the arc.
 */

export type {
  ElfaSentiment,
  ElfaSignal,
  ElfaSignalProvider,
  ElfaCallEvent,
  ElfaLogger,
} from './types';
export {
  createElfaClient,
  ELFA_TRENDING_PATH,
  ElfaClientError,
  ElfaTimeoutError,
  ElfaRateLimitError,
  ElfaPaymentRequiredError,
  ElfaHttpError,
  ElfaParseError,
  type ElfaClient,
  type ElfaClientDeps,
} from './client';
export { buildElfaMock } from './mock';
export { createElfaSignalProvider, type ElfaProviderDeps } from './provider';
