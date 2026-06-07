import { attestationRow, type AttestationRow, type ChainState } from '../schema';
import type { Queryable } from '../types';
import {
  insertOne,
  type Keyset,
  keysetBefore,
  num,
  selectMany,
  type NumericInput,
} from './_shared';

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
  chain_state?: ChainState;
  tx_hash?: string | null;
  block_number?: NumericInput | null;
  confirmed_at?: Date | null;
}

export function insertAttestation(db: Queryable, input: NewAttestation): Promise<AttestationRow> {
  return insertOne(
    db,
    'attestations',
    {
      agent_id: input.agent_id,
      round_id: input.round_id,
      value: num(input.value),
      value_decimals: input.value_decimals,
      tag1: input.tag1,
      tag2: input.tag2,
      feedback_uri: input.feedback_uri,
      feedback_hash: input.feedback_hash,
      chain_state: input.chain_state,
      tx_hash: input.tx_hash,
      block_number:
        input.block_number === null || input.block_number === undefined
          ? input.block_number
          : num(input.block_number),
      confirmed_at: input.confirmed_at,
    },
    attestationRow,
  );
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
): Promise<AttestationRow[]> {
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
  values.push(params.limit);
  return selectMany(
    db,
    `SELECT * FROM attestations ${where}ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
    values,
    attestationRow,
  );
}
