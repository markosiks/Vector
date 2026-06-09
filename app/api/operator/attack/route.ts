import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { type AttackResultDto, toAttackResultDto } from '@/lib/api/dto';
import { BadRequestError } from '@/lib/api/errors';
import { ok, readJson, route } from '@/lib/api/respond';
import { withTransaction } from '@/lib/db/client';
import { insertOperatorAction } from '@/lib/db/repos/operator-actions';
import { requireOperator } from '@/lib/operator/auth';
import { injectScriptedAttack } from '@/lib/operator/inject-attack';

/**
 * `POST /api/operator/attack` — fire the scripted drain at the current leader
 * through the **real** referee (§11.1, task 4). Operator only.
 *
 * The body carries an `idempotency_key` (a per-click uuid): the injected Intent's
 * nonce is derived from it, so the durable `(agent, nonce)` unique constraint
 * makes a retried/double-submitted click a no-op (no second Intent, no second
 * `policy_event`, no duplicate audit row). The injection and its audit row
 * commit in one transaction.
 *
 * The decision is the referee's own: a `transfer` to the canned fresh wallet is
 * REJECTed `hard` (rule #3), or HALTed when the global kill switch / the leader's
 * per-agent HALT is active. Nothing here softens it.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ idempotency_key: z.string().uuid() }).strict();

export function POST(req: NextRequest): Promise<Response> {
  return route(async () => {
    requireOperator(req);

    const parsed = body.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new BadRequestError('Expected { idempotency_key: uuid }', 'invalid_body');
    }

    const payload: AttackResultDto = await withTransaction(async (tx) => {
      const result = await injectScriptedAttack({
        db: tx,
        idempotencyKey: parsed.data.idempotency_key,
      });
      // Audit only a real injection; an idempotent retry already logged its click.
      if (!result.duplicate) {
        await insertOperatorAction(tx, {
          kind: 'attack',
          agent_id: result.target.leader.id,
          detail_json: {
            decision: result.decision.decision,
            severity: result.decision.severity,
            rule_fired: result.decision.rule_fired,
            intent_hash: result.intentHash,
            intent_id: result.intentId,
          },
        });
      }
      return toAttackResultDto(result);
    });

    return ok(payload);
  });
}
