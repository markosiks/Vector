import type { NextRequest } from 'next/server';

import {
  type AgentDetailDto,
  toAgentDto,
  toIntentDto,
  toOutcomeDto,
  toPolicyEventDto,
  toScoreDto,
} from '@/lib/api/dto';
import { NotFoundError } from '@/lib/api/errors';
import { parseLimit, parseUuid } from '@/lib/api/query';
import { ok, route } from '@/lib/api/respond';
import { getPool } from '@/lib/db/client';
import { getAgent } from '@/lib/db/repos/agents';
import { listIntentsByAgent } from '@/lib/db/repos/intents';
import { listRecentOutcomesByAgent } from '@/lib/db/repos/outcomes';
import { listRecentPolicyEventsByAgent } from '@/lib/db/repos/policy-events';
import { listScoreHistoryByAgent } from '@/lib/db/repos/scores';

/**
 * `GET /api/agents/[id]` — one agent's detail: its EWMA score history (oldest
 * round first), recent intents, the referee decisions on them, and recent
 * outcomes. The UI correlates an intent with its decision by `intent_id`, so the
 * lists are returned side by side rather than as a fragile nested join.
 *
 * A malformed `id` is `400 invalid_id`; a well-formed id matching no agent is
 * `404 agent_not_found` — the two are kept distinct so an id probe never reads
 * as a real "not found". `?limit=` bounds the recent intents/events/outcomes;
 * the score history is bounded by the number of rounds.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const id = parseUuid((await ctx.params).id);
    const limit = parseLimit(new URL(req.url).searchParams.get('limit'));
    const db = getPool();

    const agent = await getAgent(db, id);
    if (agent === null) {
      throw new NotFoundError('agent not found', 'agent_not_found');
    }

    const [scores, intents, policyEvents, outcomes] = await Promise.all([
      listScoreHistoryByAgent(db, id),
      listIntentsByAgent(db, id, limit),
      listRecentPolicyEventsByAgent(db, id, limit),
      listRecentOutcomesByAgent(db, id, limit),
    ]);

    const payload: AgentDetailDto = {
      agent: toAgentDto(agent),
      scores: scores.map(toScoreDto),
      intents: intents.map(toIntentDto),
      policy_events: policyEvents.map(toPolicyEventDto),
      outcomes: outcomes.map(toOutcomeDto),
    };
    return ok(payload);
  });
}
