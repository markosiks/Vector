import type { NextRequest } from 'next/server';

import { toAttestationDto } from '@/lib/api/dto';
import { parseChainState, parseCursor, parseLimit } from '@/lib/api/query';
import { ok, paginate, route } from '@/lib/api/respond';
import { getPool } from '@/lib/db/client';
import { listAttestationsPage } from '@/lib/db/repos/attestations';

/**
 * `GET /api/attestations` — ERC-8004 attestation records mirrored in Neon,
 * newest first, with their `chain_state` (`optimistic`/`confirmed`/`failed`),
 * `tx_hash`, and `block_number`. Optional `?chain_state=` filter and keyset
 * `?cursor=` pagination; `?limit=` bounds the page.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(req: NextRequest): Promise<Response> {
  return route(async () => {
    const params = new URL(req.url).searchParams;
    const limit = parseLimit(params.get('limit'));
    const chainState = parseChainState(params.get('chain_state'));
    const cursor = parseCursor(params.get('cursor'));

    const rows = await listAttestationsPage(getPool(), {
      limit,
      ...(chainState !== undefined ? { chainState } : {}),
      ...(cursor !== null ? { before: cursor } : {}),
    });
    return ok(paginate(rows, toAttestationDto, limit));
  });
}
