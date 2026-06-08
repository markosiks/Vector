import type { Hex } from 'viem';

import {
  getAttestationById,
  reconcileAttestation,
  type AttestationReconcile,
} from '@/lib/db/repos/attestations';
import type { AttestationRow } from '@/lib/db/schema';
import type { Queryable } from '@/lib/db/types';

/**
 * Reconcile an optimistic attestation against its transaction receipt (P1.8,
 * task 5): watch the chain and flip `optimistic → confirmed` (with `tx_hash`,
 * `block_number`, `confirmed_at`) or `optimistic → failed`. The demo arc never
 * waits on this — it runs after settle, off the critical path.
 *
 * The receipt source is injected behind a narrow {@link ReceiptReader} and the
 * clock/sleep are injectable, so the whole state machine — pending → confirmed,
 * pending → reverted, RPC flap, exhausted retries — is deterministically
 * unit-testable without a network or real time. Polling uses bounded exponential
 * backoff with a hard attempt cap so a silent/stuck chain terminates the watcher
 * (leaving the row `optimistic` for a later sweep) rather than spinning forever.
 *
 * Failure policy is deliberate: a **revert** is terminal (`failed`); a transport
 * error or a still-pending receipt is *not* — exhausting retries returns
 * `pending` and leaves the row `optimistic`, because a transient RPC failure
 * must never be mistaken for a real on-chain failure (fail open to retry, never
 * a false `failed`).
 */

/** The minimal receipt shape the watcher needs from a chain client. */
export interface FeedbackReceipt {
  readonly status: 'success' | 'reverted';
  readonly blockNumber: bigint;
}

/** Read capability for transaction receipts. Returns `null` while still pending. */
export interface ReceiptReader {
  /** The receipt for `hash`, or `null` if the transaction is not yet mined. */
  getReceipt(hash: Hex): Promise<FeedbackReceipt | null>;
}

/** Tunable backoff/retry policy for {@link reconcile}. */
export interface ReconcilePolicy {
  /** Maximum receipt polls before giving up (stays `optimistic`). Default 8. */
  readonly maxAttempts: number;
  /** First inter-poll delay in ms; doubles each attempt up to {@link maxDelayMs}. Default 500. */
  readonly baseDelayMs: number;
  /** Upper bound on a single inter-poll delay in ms. Default 8000. */
  readonly maxDelayMs: number;
}

/** Injectable clock/sleep so the watcher is deterministic under test. */
export interface ReconcileClock {
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_RECONCILE_POLICY: ReconcilePolicy = {
  maxAttempts: 8,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

const DEFAULT_CLOCK: ReconcileClock = {
  now: () => new Date(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Terminal or non-terminal disposition of a reconcile run. */
export type ReconcileStatus = 'confirmed' | 'failed' | 'pending';

/** Result of {@link reconcile}. */
export interface ReconcileResult {
  readonly status: ReconcileStatus;
  /** The attestation row after the transition (or the current row when unchanged). */
  readonly attestation: AttestationRow | null;
}

/** Dependencies for {@link reconcile}. */
export interface ReconcileDeps {
  readonly db: Queryable;
  readonly receipts: ReceiptReader;
  readonly policy?: Partial<ReconcilePolicy>;
  readonly clock?: ReconcileClock;
}

/** Compute the delay before the next poll: bounded exponential backoff. */
function backoffDelay(attempt: number, policy: ReconcilePolicy): number {
  const raw = policy.baseDelayMs * 2 ** attempt;
  return Math.min(policy.maxDelayMs, raw);
}

/**
 * Apply a terminal receipt to the attestation row, returning the post-transition
 * status + row. The DB update is forward-only guarded (`chain_state =
 * 'optimistic'`); if another watcher already reconciled it, re-read and report
 * the persisted state rather than claiming a transition we did not make.
 */
async function applyTerminal(
  db: Queryable,
  reconcile: AttestationReconcile,
  status: Exclude<ReconcileStatus, 'pending'>,
): Promise<ReconcileResult> {
  const updated = await reconcileAttestation(db, reconcile);
  if (updated !== null) {
    return { status, attestation: updated };
  }
  // Already reconciled (concurrent watcher / replay): report the current row.
  const current = await getAttestationById(db, reconcile.id);
  if (current === null) {
    return { status: 'pending', attestation: null };
  }
  const persisted: ReconcileStatus =
    current.chain_state === 'confirmed'
      ? 'confirmed'
      : current.chain_state === 'failed'
        ? 'failed'
        : 'pending';
  return { status: persisted, attestation: current };
}

/**
 * Watch the attestation's transaction until its receipt resolves or the retry
 * budget is exhausted. The attestation must already carry a `tx_hash` (set by
 * {@link import('./submit').submitAttestation}); an attestation with no hash, or
 * one already terminal, is returned as-is without polling.
 */
export async function reconcile(
  deps: ReconcileDeps,
  attestationId: string,
): Promise<ReconcileResult> {
  const policy = { ...DEFAULT_RECONCILE_POLICY, ...deps.policy };
  const clock = deps.clock ?? DEFAULT_CLOCK;

  const row = await getAttestationById(deps.db, attestationId);
  if (row === null) {
    return { status: 'pending', attestation: null };
  }
  if (row.chain_state === 'confirmed') {
    return { status: 'confirmed', attestation: row };
  }
  if (row.chain_state === 'failed') {
    return { status: 'failed', attestation: row };
  }
  if (row.tx_hash === null) {
    // Not yet submitted on-chain — nothing to reconcile against.
    return { status: 'pending', attestation: row };
  }
  const txHash = row.tx_hash as Hex;

  for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
    let receipt: FeedbackReceipt | null;
    try {
      receipt = await deps.receipts.getReceipt(txHash);
    } catch {
      // Transport flap: do NOT mark failed — retry, then leave optimistic if we
      // never get a receipt. A confirmed tx must not become a false `failed`.
      receipt = null;
    }

    if (receipt !== null) {
      if (receipt.status === 'success') {
        return applyTerminal(
          deps.db,
          {
            id: row.id,
            chainState: 'confirmed',
            blockNumber: receipt.blockNumber.toString(),
            confirmedAt: clock.now(),
          },
          'confirmed',
        );
      }
      return applyTerminal(deps.db, { id: row.id, chainState: 'failed' }, 'failed');
    }

    if (attempt < policy.maxAttempts - 1) {
      await clock.sleep(backoffDelay(attempt, policy));
    }
  }

  // Exhausted the budget with no receipt: stays optimistic for a later sweep.
  return { status: 'pending', attestation: row };
}
