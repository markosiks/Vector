import type { NextRequest } from 'next/server';

import { CONFIG } from '@/lib/config/constants';
import {
  type OperatorStateDto,
  toKillSwitchDto,
  toLeaderboardEntryDto,
  toOperatorActionDto,
  toRoundDto,
} from '@/lib/api/dto';
import { ok, route } from '@/lib/api/respond';
import { getPool } from '@/lib/db/client';
import { getKillSwitch } from '@/lib/db/repos/kill-switch';
import { listLeaderboard } from '@/lib/db/repos/leaderboard';
import { listRecentOperatorActions } from '@/lib/db/repos/operator-actions';
import { getLatestRound } from '@/lib/db/repos/rounds';
import { requireOperator } from '@/lib/operator/auth';

/**
 * `GET /api/operator/state` — the operator console's hydration payload: the
 * current global kill-switch state, the agents (leaderboard, with per-agent
 * status), the current round, and the recent audit feed. Operator-only.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(req: NextRequest): Promise<Response> {
  return route(async () => {
    requireOperator(req);
    const db = getPool();

    const [killSwitch, round, actions] = await Promise.all([
      getKillSwitch(db),
      getLatestRound(db),
      listRecentOperatorActions(db),
    ]);
    const agents = await listLeaderboard(db, round?.id ?? null);

    const payload: OperatorStateDto = {
      kill_switch: toKillSwitchDto(killSwitch),
      agents: agents.map(toLeaderboardEntryDto),
      capital_unit: CONFIG.capital.capital_unit_label,
      round: round === null ? null : toRoundDto(round),
      recent_actions: actions.map(toOperatorActionDto),
    };
    return ok(payload);
  });
}
