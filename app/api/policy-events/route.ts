import type { NextRequest } from 'next/server';

import { toPolicyEventDto } from '@/lib/api/dto';
import { parseCursor, parseLimit } from '@/lib/api/query';
import { ok, paginate, route } from '@/lib/api/respond';
import { getPool } from '@/lib/db/client';
import { listPolicyEventsPage } from '@/lib/db/repos/policy-events';

/**
 * `GET /api/policy-events` — the red-alert feed of referee decisions
 * (REJECT/HALT/CLIP/ALLOW) across all agents, newest first. Keyset-paginated via
 * `?cursor=` so a freshly written REJECT/HALT appears at the head within one
 * poll without paging skipping or repeating rows. `?limit=` bounds the page.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(req: NextRequest): Promise<Response> {
  return route(async () => {
    const params = new URL(req.url).searchParams;
    const limit = parseLimit(params.get('limit'));
    const cursor = parseCursor(params.get('cursor'));

    const rows = await listPolicyEventsPage(getPool(), limit, cursor ?? undefined);
    return ok(paginate(rows, toPolicyEventDto, limit));
  });
}
