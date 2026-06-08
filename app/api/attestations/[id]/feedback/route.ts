import { NextResponse, type NextRequest } from 'next/server';

import { NotFoundError } from '@/lib/api/errors';
import { parseUuid } from '@/lib/api/query';
import { route } from '@/lib/api/respond';
import { getPool } from '@/lib/db/client';
import { getAttestationById } from '@/lib/db/repos/attestations';

/**
 * `GET /api/attestations/[id]/feedback` — the off-chain ERC-8004 feedback
 * **detail** for one attestation, served from Neon at the on-chain `feedbackURI`.
 *
 * The body is the **exact stored bytes** (`attestations.feedback_detail`), not a
 * re-serialization, so `KECCAK-256(body)` always equals the on-chain
 * `feedback_hash` — a client can fetch this, hash it, and prove integrity. The
 * hash is echoed in `X-Feedback-Hash` / `ETag` for convenience; it is *not* the
 * source of truth (the body is). A malformed `id` is `400`; a well-formed id
 * with no attestation, or one whose detail has not been built yet, is `404`.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return route(async () => {
    const id = parseUuid((await ctx.params).id);
    const row = await getAttestationById(getPool(), id);
    if (row === null || row.feedback_detail === null) {
      throw new NotFoundError('attestation detail not found', 'attestation_not_found');
    }
    return new NextResponse(row.feedback_detail, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...(row.feedback_hash !== null
          ? { 'X-Feedback-Hash': row.feedback_hash, ETag: `"${row.feedback_hash}"` }
          : {}),
      },
    });
  });
}
