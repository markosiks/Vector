import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { type KillSwitchDto, toKillSwitchDto } from '@/lib/api/dto';
import { BadRequestError } from '@/lib/api/errors';
import { ok, readJson, route } from '@/lib/api/respond';
import { withTransaction } from '@/lib/db/client';
import { setKillSwitch } from '@/lib/db/repos/kill-switch';
import { insertOperatorAction } from '@/lib/db/repos/operator-actions';
import { requireOperator } from '@/lib/operator/auth';

/**
 * `POST /api/operator/kill-switch` — toggle the global HALT (§11.1). Operator
 * only. The state change and its audit row commit in one transaction, so the
 * referee can never read a toggled switch with no audit trail. The write is an
 * atomic singleton upsert, so it is naturally idempotent: re-posting the same
 * `active` is a safe no-op state-wise.
 *
 * The referee enforces the result: while `active`, rule #1 HALTs every Intent
 * (P1.1), and the Capital Router gates every agent out (P1.3) — nothing here
 * re-implements that; this only flips the switch they read.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z
  .object({
    active: z.boolean(),
    reason: z.string().trim().max(500).nullish(),
  })
  .strict();

export function POST(req: NextRequest): Promise<Response> {
  return route(async () => {
    requireOperator(req);

    const parsed = body.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new BadRequestError('Expected { active: boolean, reason?: string }', 'invalid_body');
    }
    const { active, reason } = parsed.data;

    const payload: KillSwitchDto = await withTransaction(async (tx) => {
      const row = await setKillSwitch(tx, { active, reason: reason ?? null, set_by: 'operator' });
      await insertOperatorAction(tx, {
        kind: 'kill_switch',
        detail_json: { active, reason: reason ?? null },
      });
      return toKillSwitchDto(row);
    });

    return ok(payload);
  });
}
