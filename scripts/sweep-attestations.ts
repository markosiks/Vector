/**
 * Sweep stuck-optimistic attestation rows and retry the on-chain submit.
 *
 * Docs and comments throughout the codebase promise "a later sweep retries"
 * rows that stay `optimistic` after the reconcile watcher exhausts its budget
 * (e.g. an RPC timeout that occurred after `giveFeedback` was broadcast but
 * before the receipt was fetched). This script is that sweep (A-02).
 *
 * It queries every `optimistic` attestation, filters to the ones that are
 * genuinely stuck (older than {@link STUCK_OPTIMISTIC_MS}), and re-runs
 * `submitAndReconcile` for each. Already-submitted rows are idempotent
 * (short-circuit in `submitAttestation`) and already-reconciled rows resolve
 * immediately in `reconcile`.
 *
 * Usage (against a real DATABASE_URL):
 *
 *   DATABASE_URL='postgresql://…' bun run scripts/sweep-attestations.ts
 *
 * Or as a cron with `SWEEP_LIMIT` to bound the batch size:
 *
 *   DATABASE_URL='postgresql://…' SWEEP_LIMIT=50 bun run scripts/sweep-attestations.ts
 */
import { Pool } from '@neondatabase/serverless';

import { listAttestationsByChainState } from '@/lib/db/repos/attestations';
import { toQueryable } from '@/lib/db/client';
import { isStuckOptimistic, STUCK_OPTIMISTIC_MS } from '@/lib/credibility/chain-state';
import { submitAndReconcile } from '@/lib/attestation/pipeline';
import {
  getAttestorAddress,
  getFeedbackWriteClient,
  getIdentityReader,
  getReceiptReader,
} from '@/lib/chain/client';
import type { AttestationDto } from '@/lib/api/dto';

const DATABASE_URL = process.env.DATABASE_URL;
if (typeof DATABASE_URL !== 'string' || DATABASE_URL.length === 0) {
  throw new Error('DATABASE_URL is required');
}

const SWEEP_LIMIT = Number(process.env.SWEEP_LIMIT ?? 100);
// The sweep writes `feedbackURI` permanently on-chain (canonical ERC-8004 has no
// updateFeedback). A `https://localhost` fallback would bake an unreachable URI
// into the chain forever, breaking every verifier's integrity check — so require
// an explicit public base URL rather than silently defaulting.
const BASE_URL = process.env.PUBLIC_BASE_URL;
if (typeof BASE_URL !== 'string' || BASE_URL.length === 0) {
  throw new Error(
    'PUBLIC_BASE_URL is required: the on-chain feedbackURI is immutable, so it must point at the public deployment, not a localhost fallback',
  );
}

const pool = new Pool({ connectionString: DATABASE_URL });
const db = toQueryable(await pool.connect());

const rows = await listAttestationsByChainState(db, 'optimistic', SWEEP_LIMIT);

/** Convert an AttestationRow to the minimal shape isStuckOptimistic needs. */
function toDto(row: { chain_state: string; created_at: Date }): Pick<AttestationDto, 'chain_state' | 'created_at'> {
  return {
    chain_state: row.chain_state as AttestationDto['chain_state'],
    created_at: row.created_at.toISOString(),
  };
}

const now = new Date();
const stuck = rows.filter((r) => isStuckOptimistic(toDto(r), now, STUCK_OPTIMISTIC_MS));

// `submitAttestation` fails closed on a null/malformed on-chain id, so resolve
// the CURRENT `agents.agent_id_onchain` for every stuck row up front (an agent
// may have been registered long after its attestation row was mirrored).
const onchainIds = new Map<string, string | null>();
if (stuck.length > 0) {
  const agentIds = [...new Set(stuck.map((r) => r.agent_id))];
  const res = await db.query<{ id: string; agent_id_onchain: string | null }>(
    'SELECT id, agent_id_onchain FROM agents WHERE id = ANY($1)',
    [agentIds],
  );
  for (const a of res.rows) {
    onchainIds.set(a.id, a.agent_id_onchain);
  }
}

console.log(`[sweep] ${rows.length} optimistic row(s), ${stuck.length} stuck (>${STUCK_OPTIMISTIC_MS}ms old).`);

let ok = 0;
let failed = 0;

for (const row of stuck) {
  try {
    const result = await submitAndReconcile(
      {
        db,
        writer: getFeedbackWriteClient(),
        reader: getIdentityReader(),
        attestor: getAttestorAddress(),
        baseUrl: BASE_URL,
      },
      { receipts: getReceiptReader() },
      { attestationId: row.id, agentOnchainId: onchainIds.get(row.agent_id) ?? null },
    );
    console.log(`[sweep] ${row.id}: submit=${result.submit.status} reconcile=${result.reconcile?.status ?? 'n/a'}`);
    ok += 1;
  } catch (err) {
    console.error(`[sweep] ${row.id}: error`, err);
    failed += 1;
  }
}

console.log(`[sweep] done — ${ok} processed, ${failed} errored.`);
await pool.end();
