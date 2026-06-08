/**
 * The Nansen smart-money signal (P2.2, §7.6): a read-only hint placed in a seed
 * agent's `context.signals.nansen`. A single Smart Money `netflows` call, fronted
 * by a TTL cache and slow poller, injected into the leader's decision context —
 * never into execution, and never on the tick's critical path. See
 * `docs/nansen-signal.md`.
 *
 * This barrel re-exports only the transport-pure surface (types, client,
 * provider). The `server-only` key loader lives in `./load` and is imported
 * directly by the (server-side) caller that wires the arc.
 */

export type {
  NansenNetflow,
  NansenSignal,
  NansenSignalProvider,
  NansenCallEvent,
  NansenLogger,
} from './types';
export {
  createNansenClient,
  NANSEN_NETFLOWS_PATH,
  NansenClientError,
  NansenTimeoutError,
  NansenRateLimitError,
  NansenHttpError,
  NansenParseError,
  type NansenClient,
  type NansenClientDeps,
} from './client';
export { createNansenSignalProvider, type NansenProviderDeps } from './provider';
