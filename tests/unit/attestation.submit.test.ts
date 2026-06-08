import { describe, expect, test } from 'bun:test';
import type { Address, Hex } from 'viem';

import type { IdentityReader } from '@/lib/chain/identity';
import {
  AttestationSubmitError,
  buildFeedbackUri,
  submitAttestation,
  type FeedbackWriteArgs,
  type FeedbackWriteClient,
} from '@/lib/attestation/submit';
import type { AttestationRow } from '@/lib/db/schema';
import type { Queryable } from '@/lib/db/types';

import { FakeAttestationDb } from '../fixtures/attestation-db';

/**
 * The submit step writes **exactly one** `giveFeedback` per attestation. These
 * pin the idempotency and fail-closed contracts with fakes for the chain seam:
 * a replay never sends twice, an unregistered agent or a self-feedback attestor
 * is rejected *before* any write, and the `tx_hash IS NULL` latch turns a lost
 * race into a typed disposition rather than a duplicate transaction.
 */

const AGENT = '11111111-1111-1111-1111-111111111111';
const ROUND = '22222222-2222-2222-2222-222222222222';
const ATTESTOR = '0x00000000000000000000000000000000000000a1' as Address;
const TX_HASH = `0x${'b'.repeat(64)}` as Hex;
const BASE = 'https://vector.app';

function optimisticRow(over: Partial<AttestationRow> = {}): AttestationRow {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    agent_id: AGENT,
    round_id: ROUND,
    value: '74',
    value_decimals: 0,
    tag1: ROUND,
    tag2: 'violation',
    feedback_uri: null,
    feedback_hash: `0x${'a'.repeat(64)}`,
    feedback_detail: '{"schema":"vector.attestation.detail/1"}',
    chain_state: 'optimistic',
    tx_hash: null,
    block_number: null,
    created_at: new Date('2026-06-06T00:00:00Z'),
    confirmed_at: null,
    ...over,
  };
}

/** A reader where the agent exists and the attestor is *not* its owner (can attest). */
function attestableReader(): IdentityReader {
  return {
    ownerOf: async () => '0x00000000000000000000000000000000000000ff' as Address,
    isAuthorizedOrOwner: async () => false,
  };
}

function recordingWriter(): FeedbackWriteClient & { calls: FeedbackWriteArgs[] } {
  const calls: FeedbackWriteArgs[] = [];
  return {
    calls,
    giveFeedback: async (args: FeedbackWriteArgs) => {
      calls.push(args);
      return TX_HASH;
    },
  };
}

describe('buildFeedbackUri', () => {
  test('builds the absolute detail URL under the base', () => {
    expect(buildFeedbackUri(BASE, 'abc')).toBe('https://vector.app/api/attestations/abc/feedback');
  });

  test('tolerates a trailing slash on the base', () => {
    expect(buildFeedbackUri('https://vector.app/', 'abc')).toBe(
      'https://vector.app/api/attestations/abc/feedback',
    );
  });

  test('rejects a non-http(s) or malformed base', () => {
    expect(() => buildFeedbackUri('ftp://x', 'a')).toThrow(AttestationSubmitError);
    expect(() => buildFeedbackUri('not a url', 'a')).toThrow(AttestationSubmitError);
  });
});

describe('submitAttestation', () => {
  test('sends exactly one giveFeedback and records the tx hash + uri', async () => {
    const row = optimisticRow();
    const db = new FakeAttestationDb([row]);
    const writer = recordingWriter();

    const result = await submitAttestation(
      { db, writer, reader: attestableReader(), attestor: ATTESTOR, baseUrl: BASE },
      { attestationId: row.id, agentOnchainId: '7' },
    );

    expect(result.status).toBe('submitted');
    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]).toMatchObject({
      agentId: 7n,
      value: 74n,
      valueDecimals: 0,
      tag1: ROUND,
      tag2: 'violation',
      feedbackURI: `${BASE}/api/attestations/${row.id}/feedback`,
      feedbackHash: row.feedback_hash,
    });
    const stored = db.get(row.id);
    expect(stored?.tx_hash).toBe(TX_HASH);
    expect(stored?.feedback_uri).toBe(`${BASE}/api/attestations/${row.id}/feedback`);
  });

  test('is idempotent: a row that already has a tx hash is never re-sent', async () => {
    const row = optimisticRow({ tx_hash: TX_HASH, feedback_uri: 'https://vector.app/x' });
    const db = new FakeAttestationDb([row]);
    const writer = recordingWriter();

    const result = await submitAttestation(
      { db, writer, reader: attestableReader(), attestor: ATTESTOR, baseUrl: BASE },
      { attestationId: row.id, agentOnchainId: '7' },
    );

    expect(result.status).toBe('already_submitted');
    expect(writer.calls).toHaveLength(0);
  });

  test('fails closed for an unregistered agent (null onchain id) before any write', async () => {
    const row = optimisticRow();
    const db = new FakeAttestationDb([row]);
    const writer = recordingWriter();

    await expect(
      submitAttestation(
        { db, writer, reader: attestableReader(), attestor: ATTESTOR, baseUrl: BASE },
        { attestationId: row.id, agentOnchainId: null },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(writer.calls).toHaveLength(0);
  });

  test('fails closed when the attestor owns the agent (self-feedback) before any write', async () => {
    const row = optimisticRow();
    const db = new FakeAttestationDb([row]);
    const writer = recordingWriter();
    const selfReader: IdentityReader = {
      ownerOf: async () => ATTESTOR,
      isAuthorizedOrOwner: async () => true,
    };

    await expect(
      submitAttestation(
        { db, writer, reader: selfReader, attestor: ATTESTOR, baseUrl: BASE },
        { attestationId: row.id, agentOnchainId: '7' },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(writer.calls).toHaveLength(0);
  });

  test('fails closed for a value outside int128 range before any write', async () => {
    // The `value` column (numeric(39,0)) is wider than the registry's int128
    // argument; a value beyond int128 must be a typed error at the chain-write
    // boundary, not a cryptic ABI throw or wasted gas.
    const overInt128 = (1n << 127n).toString(); // INT128_MAX + 1
    const row = optimisticRow({ value: overInt128 });
    const db = new FakeAttestationDb([row]);
    const writer = recordingWriter();

    await expect(
      submitAttestation(
        { db, writer, reader: attestableReader(), attestor: ATTESTOR, baseUrl: BASE },
        { attestationId: row.id, agentOnchainId: '7' },
      ),
    ).rejects.toBeInstanceOf(AttestationSubmitError);
    expect(writer.calls).toHaveLength(0);
  });

  test('a lost tx_hash race is reported as `raced`, not a silent double write', async () => {
    const row = optimisticRow();
    // A db whose submission-claim UPDATE always loses the race (returns no row),
    // as if a concurrent submit recorded its hash first.
    const racingDb: Queryable = {
      async query<R = Record<string, unknown>>(sql: string) {
        if (sql.includes('SET feedback_uri')) {
          return { rows: [] as R[], rowCount: 0 };
        }
        return { rows: [row] as unknown as R[], rowCount: 1 };
      },
    };
    const writer = recordingWriter();

    const result = await submitAttestation(
      { db: racingDb, writer, reader: attestableReader(), attestor: ATTESTOR, baseUrl: BASE },
      { attestationId: row.id, agentOnchainId: '7' },
    );
    expect(result.status).toBe('raced');
    expect(result.txHash).toBe(TX_HASH);
  });

  test('throws when the attestation id is unknown', async () => {
    const db = new FakeAttestationDb([]);
    await expect(
      submitAttestation(
        {
          db,
          writer: recordingWriter(),
          reader: attestableReader(),
          attestor: ATTESTOR,
          baseUrl: BASE,
        },
        { attestationId: 'missing', agentOnchainId: '7' },
      ),
    ).rejects.toBeInstanceOf(AttestationSubmitError);
  });
});
