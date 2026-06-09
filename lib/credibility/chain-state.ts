import type { AttestationDto } from '@/lib/api/dto';
import type { ChainState } from '@/lib/db/schema';

/**
 * Presentation model for an attestation's on-chain reconciliation state (P2.3).
 *
 * The Attestation Log's whole job is to show the `optimistic → confirmed`
 * reconciliation *honestly* — including when the chain is silent (`optimistic`
 * never resolves) or the write reverted (`failed`). This module turns the raw
 * `chain_state` enum, plus a touch of derived liveness, into the small, total
 * description the badge and the row render from, with no React and no clock of
 * its own so it stays unit- and fuzz-testable.
 */

/** Visual/semantic tone for a chain state — drives the badge colour, not text. */
export type ChainStateTone = 'pending' | 'success' | 'danger';

/** The fully-resolved description of one attestation's chain state. */
export interface ChainStateMeta {
  readonly state: ChainState;
  /** Short human label for the badge (`Optimistic` / `Confirmed` / `Failed`). */
  readonly label: string;
  readonly tone: ChainStateTone;
  /** One-line explanation of what the state means for reconciliation. */
  readonly description: string;
  /** `true` once the state can no longer change (confirmed or failed). */
  readonly terminal: boolean;
}

const META: Record<ChainState, ChainStateMeta> = {
  optimistic: {
    state: 'optimistic',
    label: 'Optimistic',
    tone: 'pending',
    description: 'Written locally; awaiting on-chain confirmation.',
    terminal: false,
  },
  confirmed: {
    state: 'confirmed',
    label: 'Confirmed',
    tone: 'success',
    description: 'Mined and confirmed on Mantle Sepolia.',
    terminal: true,
  },
  failed: {
    state: 'failed',
    label: 'Failed',
    tone: 'danger',
    description: 'The on-chain transaction reverted.',
    terminal: true,
  },
};

/**
 * Describe a chain state. An unrecognized value (only reachable via a fuzzed or
 * corrupt DTO — the API enum is closed) falls back to a `pending`/`danger`-free
 * neutral description rather than throwing, so the row still renders.
 */
export function chainStateMeta(state: ChainState | string): ChainStateMeta {
  return (
    META[state as ChainState] ?? {
      state: state as ChainState,
      label: String(state),
      tone: 'pending',
      description: 'Unknown chain state.',
      terminal: false,
    }
  );
}

/**
 * Default window after which an unconfirmed `optimistic` attestation is treated
 * as "the chain has gone quiet" — long enough to clear the reconcile watcher's
 * bounded backoff budget (8 attempts × ≤8 s), so a normal pending write is never
 * mislabelled, but a genuinely stuck row is surfaced for an operator sweep.
 */
export const STUCK_OPTIMISTIC_MS = 90_000;

/**
 * `true` when `att` is still `optimistic` and was created more than
 * `thresholdMs` ago relative to `now` — i.e. the chain has been silent past the
 * reconcile budget and the row is stuck pending, not merely in-flight.
 *
 * A non-`optimistic` row is never stuck. An unparseable `created_at` returns
 * `false` (we do not invent a "stuck" signal from a bad timestamp).
 */
export function isStuckOptimistic(
  att: Pick<AttestationDto, 'chain_state' | 'created_at'>,
  now: Date,
  thresholdMs: number = STUCK_OPTIMISTIC_MS,
): boolean {
  if (att.chain_state !== 'optimistic') return false;
  const created = Date.parse(att.created_at);
  if (!Number.isFinite(created)) return false;
  return now.getTime() - created >= thresholdMs;
}
