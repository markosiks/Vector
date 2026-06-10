import { z } from 'zod';

import { attestationRow, type AttestationRow, type ChainState } from '../schema';
import type { Queryable } from '../types';
import {
  CURSOR_KEY_SQL,
  insertOne,
  insertOneOrNull,
  type Keyset,
  keysetBefore,
  num,
  selectMany,
  selectOne,
  type NumericInput,
} from './_shared';

/**
 * A page row carries the microsecond-precision {@link CURSOR_KEY_SQL} alias
 * alongside the domain row (see {@link import('../../api/respond').paginate}).
 */
const attestationPageRow = attestationRow.extend({ cursor_t: z.string() });
export type AttestationPageRow = z.infer<typeof attestationPageRow>;

/** Fields accepted when mirroring an ERC-8004 attestation into Neon. */
export interface NewAttestation {
  agent_id: string;
  round_id: string;
  value: NumericInput;
  value_decimals?: number;
  tag1?: string | null;
  tag2?: string | null;
  feedback_uri?: string | null;
  feedback_hash?: string | null;
  /** Canonical off-chain detail JSON served at `feedback_uri`. */
  feedback_detail?: string | null;
  chain_state?: ChainState;
  tx_hash?: string | null;
  block_number?: NumericInput | null;
  confirmed_at?: Date | null;
}

/** The `attestations` column→value map shared by the plain and idempotent inserts. */
function attestationColumns(input: NewAttestation): Record<string, unknown> {
  return {
    agent_id: input.agent_id,
    round_id: input.round_id,
    value: num(input.value),
    value_decimals: input.value_decimals,
    tag1: input.tag1,
    tag2: input.tag2,
    feedback_uri: input.feedback_uri,
    feedback_hash: input.feedback_hash,
    feedback_detail: input.feedback_detail,
    chain_state: input.chain_state,
    tx_hash: input.tx_hash,
    block_number:
      input.block_number === null || input.block_number === undefined
        ? input.block_number
        : num(input.block_number),
    confirmed_at: input.confirmed_at,
  };
}

export function insertAttestation(db: Queryable, input: NewAttestation): Promise<AttestationRow> {
  return insertOne(db, 'attestations', attestationColumns(input), attestationRow);
}

/**
 * Mirror an attestation idempotently: insert the `(agent_id, round_id)` row, or
 * return `null` when one already exists (the `UNIQUE (agent_id, round_id)`
 * constraint is `ON CONFLICT DO NOTHING`). This is the **exactly-one-per-round**
 * guarantee at the persistence boundary — a double settle, a settlement re-run,
 * or a retry never writes a second mirror; the caller re-reads the existing row
 * ({@link getAttestationByAgentRound}) and converges from it, mirroring the
 * `insertScore` idempotency pattern. History is never overwritten.
 */
export function insertAttestationOptimistic(
  db: Queryable,
  input: NewAttestation,
): Promise<AttestationRow | null> {
  return insertOneOrNull(db, 'attestations', attestationColumns(input), attestationRow, {
    onConflictDoNothing: ['agent_id', 'round_id'],
  });
}

/** The attestation for one agent in one round, or `null` if none was mirrored. */
export function getAttestationByAgentRound(
  db: Queryable,
  agentId: string,
  roundId: string,
): Promise<AttestationRow | null> {
  return selectOne(
    db,
    'SELECT * FROM attestations WHERE agent_id = $1 AND round_id = $2',
    [agentId, roundId],
    attestationRow,
  );
}

/** A single attestation by id, or `null` (the `feedbackURI` endpoint read). */
export function getAttestationById(db: Queryable, id: string): Promise<AttestationRow | null> {
  return selectOne(db, 'SELECT * FROM attestations WHERE id = $1', [id], attestationRow);
}

/**
 * Atomically claim an optimistic attestation for on-chain submission and record
 * its `feedback_uri` + `tx_hash`. The `WHERE tx_hash IS NULL` guard makes this a
 * single-winner reservation: only the first caller to record a hash succeeds and
 * gets the row back; a concurrent or replayed submit sees `tx_hash` already set
 * and gets `null`, so **at most one** `giveFeedback` transaction is ever sent per
 * attestation — the on-chain idempotency latch, in SQL rather than a race.
 */
export async function recordAttestationSubmission(
  db: Queryable,
  input: { readonly id: string; readonly feedbackUri: string; readonly txHash: string },
): Promise<AttestationRow | null> {
  const { rows } = await db.query(
    `UPDATE attestations
        SET feedback_uri = $2, tx_hash = $3
      WHERE id = $1 AND tx_hash IS NULL
      RETURNING *`,
    [input.id, input.feedbackUri, input.txHash],
  );
  const row = rows[0];
  return row === undefined ? null : attestationRow.parse(row);
}

/** A terminal reconcile transition derived from a transaction receipt. */
export interface AttestationReconcile {
  readonly id: string;
  /** `confirmed` (receipt success) or `failed` (revert / exhausted retries). */
  readonly chainState: Extract<ChainState, 'confirmed' | 'failed'>;
  /** Block number from the receipt; set on `confirmed`. */
  readonly blockNumber?: NumericInput | null;
  /** Confirmation timestamp; set on `confirmed`. */
  readonly confirmedAt?: Date | null;
}

/**
 * Reconcile an attestation to a terminal `chain_state` from its receipt
 * (`optimistic → confirmed/failed`). Idempotent and forward-only: the
 * `WHERE chain_state = 'optimistic'` guard means a row already reconciled (by a
 * concurrent watcher, or a replay) is left untouched and returns `null`, so a
 * confirmation can never be silently overwritten by a late `failed` and a second
 * watcher cannot double-apply. A genuine reorg re-reconcile is an explicit,
 * separate operation — not this guarded fast path.
 */
export async function reconcileAttestation(
  db: Queryable,
  input: AttestationReconcile,
): Promise<AttestationRow | null> {
  const blockNumber =
    input.blockNumber === null || input.blockNumber === undefined ? null : num(input.blockNumber);
  const { rows } = await db.query(
    `UPDATE attestations
        SET chain_state = $2,
            block_number = COALESCE($3, block_number),
            confirmed_at = $4
      WHERE id = $1 AND chain_state = 'optimistic'
      RETURNING *`,
    [input.id, input.chainState, blockNumber, input.confirmedAt ?? null],
  );
  const row = rows[0];
  return row === undefined ? null : attestationRow.parse(row);
}

/** Reconcile read: attestations in a given chain_state (e.g. `optimistic`). */
export function listAttestationsByChainState(
  db: Queryable,
  state: ChainState,
  limit = 100,
): Promise<AttestationRow[]> {
  return selectMany(
    db,
    'SELECT * FROM attestations WHERE chain_state = $1 ORDER BY created_at ASC LIMIT $2',
    [state, limit],
    attestationRow,
  );
}

/** Options for {@link listAttestationsPage}. */
export interface AttestationPageParams {
  readonly limit: number;
  /** Optional `chain_state` filter (`optimistic` / `confirmed` / `failed`). */
  readonly chainState?: ChainState;
  /** Optional keyset cursor; the page continues strictly older than it. */
  readonly before?: Keyset;
}

/**
 * One keyset page of attestations for the UI, newest first
 * (`created_at DESC, id DESC`), served by `idx_attestations_created`. Optionally
 * filtered to one `chain_state`, in which case `idx_attestations_chain_state_created`
 * serves the filter and the same order in one index. The `id` tie-break keeps
 * paging deterministic when a batch reconcile stamps many rows with the same
 * `created_at`. Filter and cursor are independent and compose.
 */
export function listAttestationsPage(
  db: Queryable,
  params: AttestationPageParams,
): Promise<AttestationPageRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.chainState !== undefined) {
    values.push(params.chainState);
    conditions.push(`chain_state = $${values.length}`);
  }
  if (params.before !== undefined) {
    conditions.push(keysetBefore(params.before, values));
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')} ` : '';
  // Fetch limit+1 so paginate() can detect a further page without an extra
  // empty round-trip when the total row count is an exact multiple of limit.
  values.push(params.limit + 1);
  return selectMany(
    db,
    `SELECT *, ${CURSOR_KEY_SQL} FROM attestations ${where}ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
    values,
    attestationPageRow,
  );
}
