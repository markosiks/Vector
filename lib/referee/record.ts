import { CONFIG } from '@/lib/config/constants';
import { insertPolicyEvent } from '@/lib/db/repos/policy-events';
import type { Queryable } from '@/lib/db/types';
import { validateIntent, type ValidateOptions } from '@/lib/intent/validate';

import { evaluate } from './evaluate';
import type { RefereeConfig, RefereeResult, RefereeState } from './types';

/** Foreign keys of the persisted rows this decision attaches to. */
export interface RefereeIds {
  /** `intents.id` of the already-persisted Intent row (P0.3 → P0.2). */
  readonly intent_id: string;
  /** `agents.id` (uuid) — note this differs from the Intent's string `agent_id`. */
  readonly agent_id: string;
  /** `rounds.id` of the round this Intent belongs to. */
  readonly round_id: string;
}

export interface RunRefereeArgs {
  readonly db: Queryable;
  /** The signed Intent on the wire; re-validated through P0.3 before policy. */
  readonly input: unknown;
  readonly ids: RefereeIds;
  readonly state: RefereeState;
  /** Policy config; defaults to the seeded {@link CONFIG}.policy. */
  readonly config?: RefereeConfig;
  /** Options for the P0.3 re-validation (signer resolver, clock, nonce guard). */
  readonly validate: ValidateOptions;
}

/**
 * Run the referee end to end and persist exactly one `policy_event`.
 *
 * Defense in depth: the Intent is re-validated with the P0.3 validator before
 * any policy rule runs (reusing `lib/intent/validate.ts`, not reimplementing
 * its structural checks). A structurally-invalid Intent is rejected at
 * `pre_validation` with `severity = none`; a valid one is handed to the pure
 * {@link evaluate}. Either way the decision is written to `policy_events` via
 * the P0.2 repository, with the canonical `intent_hash` folded into
 * `detail_json` for audit (the table keys on `intent_id`, not the hash).
 *
 * The `policy_events` table is an append-only audit log: re-running the referee
 * on the same Intent yields the same *decision* (evaluate is pure) and appends
 * another event recording that re-evaluation.
 */
export async function runReferee(args: RunRefereeArgs): Promise<RefereeResult> {
  const config = args.config ?? CONFIG.policy;

  let result: RefereeResult;
  let intentHash: string | undefined;
  try {
    const validated = await validateIntent(args.input, args.validate);
    if (!validated.ok) {
      result = {
        decision: 'REJECT',
        severity: 'none',
        rule_fired: 'pre_validation',
        detail: { stage: validated.stage, code: validated.code, message: validated.message },
      };
    } else {
      intentHash = validated.intent_hash;
      result = evaluate(validated.intent, args.state, config);
    }
  } catch (err) {
    // Fail closed: an unexpected error (a throwing signer resolver, the signature
    // verifier, or evaluate itself) must never leave a submitted Intent with no
    // audit record (invariant: exactly one policy_event per decision) nor be
    // treated as a pass. Record a terminal REJECT, then re-throw so the caller
    // does not execute. The audit write is best-effort so the original cause is
    // preserved even if persistence is the thing that is failing.
    try {
      await insertPolicyEvent(args.db, {
        intent_id: args.ids.intent_id,
        agent_id: args.ids.agent_id,
        round_id: args.ids.round_id,
        rule_fired: 'internal_error',
        decision: 'REJECT',
        severity: 'hard',
        detail_json: { error: err instanceof Error ? err.name : 'unknown' },
      });
    } catch {
      // Swallow: audit persistence failed while handling an error; surface the
      // original cause below rather than masking it with this secondary failure.
    }
    throw err;
  }

  await insertPolicyEvent(args.db, {
    intent_id: args.ids.intent_id,
    agent_id: args.ids.agent_id,
    round_id: args.ids.round_id,
    rule_fired: result.rule_fired,
    decision: result.decision,
    severity: result.severity,
    detail_json: intentHash ? { ...result.detail, intent_hash: intentHash } : result.detail,
  });

  return result;
}
