import type { NextRequest } from 'next/server';

import { CONFIG } from '@/lib/config/constants';
import { type LeaderboardDto, toLeaderboardEntryDto, toRoundDto } from '@/lib/api/dto';
import { parseLimit } from '@/lib/api/query';
import { ok, route } from '@/lib/api/respond';
import { getPool } from '@/lib/db/client';
import { listLeaderboard } from '@/lib/db/repos/leaderboard';
import { getLatestRound } from '@/lib/db/repos/rounds';

/**
 * `GET /api/leaderboard` — agents ranked by current AgentScore, each with its
 * capital allocation in the current round, plus the round's status. Read-only;
 * the single writer of `agents.score_current` is the scoring engine.
 *
 * Always dynamic and on the Node runtime because it opens a database connection.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(req: NextRequest): Promise<Response> {
  return route(async () => {
    const limit = parseLimit(new URL(req.url).searchParams.get('limit'));
    const db = getPool();

    const round = await getLatestRound(db);
    const rows = await listLeaderboard(db, round?.id ?? null, limit);

    const payload: LeaderboardDto = {
      round: round === null ? null : toRoundDto(round),
      capital_unit: CONFIG.capital.capital_unit_label,
      data: rows.map(toLeaderboardEntryDto),
    };
    return ok(payload);
  });
}
