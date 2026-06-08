import { randomUUID } from 'node:crypto';

import type { AttestationRow } from '@/lib/db/schema';
import type { Queryable } from '@/lib/db/types';

/**
 * An in-memory `attestations` table for unit tests of the attestation pipeline.
 *
 * It honours the *behaviours* the repo SQL relies on — `ON CONFLICT DO NOTHING`
 * on `(agent_id, round_id)`, the `tx_hash IS NULL` submission latch, and the
 * `chain_state = 'optimistic'` forward-only reconcile guard — so the tests
 * exercise idempotency and single-winner races against real semantics rather
 * than mocks, without a Postgres dependency. It routes by SQL shape (the same
 * pattern as `scoring.record`'s fake), reading the INSERT column list from the
 * statement so it does not hard-code the repo's column order.
 */
export class FakeAttestationDb implements Queryable {
  private readonly rows = new Map<string, AttestationRow>();
  public readonly calls: { sql: string; params?: readonly unknown[] }[] = [];

  constructor(
    seed: readonly AttestationRow[] = [],
    private readonly intentHashes: readonly string[] = [],
  ) {
    for (const row of seed) {
      this.rows.set(row.id, { ...row });
    }
  }

  /** Snapshot of a stored row, by id (test assertions). */
  get(id: string): AttestationRow | undefined {
    const row = this.rows.get(id);
    return row === undefined ? undefined : { ...row };
  }

  /** All stored rows (test assertions). */
  all(): AttestationRow[] {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    this.calls.push({ sql, params });
    const result = this.dispatch(sql, params);
    return { rows: result as R[], rowCount: result.length };
  }

  private dispatch(sql: string, params: readonly unknown[]): AttestationRow[] {
    if (sql.includes('FROM intents')) {
      // The detail builder folds in the round's intent hashes.
      return this.intentHashes.map((h) => ({ intent_hash: h })) as unknown as AttestationRow[];
    }
    if (sql.startsWith('INSERT INTO attestations')) {
      return this.insert(sql, params);
    }
    if (sql.includes('SET feedback_uri')) {
      return this.recordSubmission(params);
    }
    if (sql.includes('SET chain_state')) {
      return this.reconcile(params);
    }
    if (sql.includes('WHERE id = $1')) {
      const row = this.rows.get(params[0] as string);
      return row === undefined ? [] : [{ ...row }];
    }
    if (sql.includes('WHERE agent_id = $1 AND round_id = $2')) {
      const found = [...this.rows.values()].find(
        (r) => r.agent_id === params[0] && r.round_id === params[1],
      );
      return found === undefined ? [] : [{ ...found }];
    }
    throw new Error(`FakeAttestationDb: unexpected sql: ${sql}`);
  }

  private insert(sql: string, params: readonly unknown[]): AttestationRow[] {
    const cols = (sql.match(/\(([^)]+)\) VALUES/)?.[1] ?? '').split(',').map((c) => c.trim());
    const provided: Record<string, unknown> = {};
    cols.forEach((col, i) => {
      provided[col] = params[i];
    });

    const agentId = provided.agent_id as string;
    const roundId = provided.round_id as string;
    const conflict = sql.includes('ON CONFLICT');
    if (conflict) {
      const clash = [...this.rows.values()].some(
        (r) => r.agent_id === agentId && r.round_id === roundId,
      );
      if (clash) {
        return []; // ON CONFLICT DO NOTHING
      }
    }

    const row: AttestationRow = {
      id: randomUUID(),
      agent_id: agentId,
      round_id: roundId,
      value: String(provided.value ?? '0'),
      value_decimals: Number(provided.value_decimals ?? 0),
      tag1: (provided.tag1 as string | undefined) ?? null,
      tag2: (provided.tag2 as string | undefined) ?? null,
      feedback_uri: (provided.feedback_uri as string | undefined) ?? null,
      feedback_hash: (provided.feedback_hash as `0x${string}` | undefined) ?? null,
      feedback_detail: (provided.feedback_detail as string | undefined) ?? null,
      chain_state:
        (provided.chain_state as AttestationRow['chain_state'] | undefined) ?? 'optimistic',
      tx_hash: (provided.tx_hash as string | undefined) ?? null,
      block_number: (provided.block_number as string | undefined) ?? null,
      created_at: new Date(),
      confirmed_at: null,
    };
    this.rows.set(row.id, row);
    return [{ ...row }];
  }

  private recordSubmission(params: readonly unknown[]): AttestationRow[] {
    const [id, feedbackUri, txHash] = params as [string, string, string];
    const row = this.rows.get(id);
    if (row === undefined || row.tx_hash !== null) {
      return []; // lost the `tx_hash IS NULL` race / already submitted
    }
    row.feedback_uri = feedbackUri;
    row.tx_hash = txHash;
    return [{ ...row }];
  }

  private reconcile(params: readonly unknown[]): AttestationRow[] {
    const [id, chainState, blockNumber, confirmedAt] = params as [
      string,
      AttestationRow['chain_state'],
      string | null,
      Date | null,
    ];
    const row = this.rows.get(id);
    if (row === undefined || row.chain_state !== 'optimistic') {
      return []; // forward-only guard: already reconciled
    }
    row.chain_state = chainState;
    if (blockNumber !== null) {
      row.block_number = blockNumber;
    }
    row.confirmed_at = confirmedAt;
    return [{ ...row }];
  }
}
