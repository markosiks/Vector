import { attestationRow, type AttestationRow, type ChainState } from '../schema';
import type { Queryable } from '../types';
import { insertOne, num, selectMany, type NumericInput } from './_shared';

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
