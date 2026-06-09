import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { type AgentDto, toAgentDto } from '@/lib/api/dto';
import { BadRequestError, NotFoundError } from '@/lib/api/errors';
import { ok, readJson, route } from '@/lib/api/respond';
import { withTransaction } from '@/lib/db/client';
import { setAgentStatus } from '@/lib/db/repos/agents';
import { insertOperatorAction } from '@/lib/db/repos/operator-actions';
import { OPERATOR_SETTABLE_STATUS, operatorStatusBody } from '@/lib/operator/agent-status-input';
import { requireOperator } from '@/lib/operator/auth';

/**
 * `POST /api/operator/agents/:id/status` — set one agent's operator status, the
 * per-agent HALT control (§11.1). Operator only; the status write and its audit
 * row commit atomically.
 *
 * The console exposes exactly two operator-settable states: `halted` and
 * `active` (resume). `'gated'` is **deliberately excluded** — it is the scoring
 * engine's exclusive domain and, crucially, it does NOT stop intent execution:
 * the referee only HALTs on `status === 'halted'`, while `'gated'` merely gates
 * the agent out of capital allocation (P1.3). Accepting `'gated'` here would let
 * an operator believe they had halted an agent on the safety console while its
 * Intents kept flowing through the referee — a per-agent HALT bypass. The
 * blocking control must only ever flip between `halted` and `active`.
 *
 * A per-agent HALT cuts the agent two ways, both already enforced by the
 * components that read `agents.status`: the referee HALTs its Intents (rule #1b,
 * P2.4) and the Capital Router gates it out of the allocation (P1.3). This route
 * only flips the status those reads key on.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const paramId = z.string().uuid();
const body = operatorStatusBody;

export function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return route(async () => {
    requireOperator(req);

    const idParsed = paramId.safeParse((await ctx.params).id);
    if (!idParsed.success) {
      throw new BadRequestError('Agent id must be a uuid', 'invalid_id');
    }
    const parsed = body.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new BadRequestError(
        `Expected { status: ${OPERATOR_SETTABLE_STATUS.join(' | ')} }`,
        'invalid_body',
      );
    }
    const id = idParsed.data;
    const { status } = parsed.data;

    const payload: AgentDto = await withTransaction(async (tx) => {
      const row = await setAgentStatus(tx, id, status);
      if (row === null) {
        // Roll the (empty) transaction back by throwing; a 404 for an unknown id.
        throw new NotFoundError('No agent with that id', 'agent_not_found');
      }
      await insertOperatorAction(tx, {
        kind: 'agent_status',
        agent_id: id,
        detail_json: { status },
      });
      return toAgentDto(row);
    });

    return ok(payload);
  });
}
