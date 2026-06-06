import type { Intent } from '@/lib/intent/types';

import { BLOCKING_RULES, CLIPPING_RULES } from './rules';
import type { RefereeConfig, RefereeResult, RefereeState } from './types';

/** A fresh ALLOW result (never a shared reference, so callers can't alias it). */
const allow = (): RefereeResult => ({
  decision: 'ALLOW',
  severity: 'none',
  rule_fired: 'allow',
  detail: {},
});

/**
 * Fold every CLIP that fired into a single decision. A lone clip is returned
 * verbatim (so it keeps its own `rule_fired`/`detail`); multiple clips are
 * merged — `rule_fired` joins the rule ids and `detail.clips` records each
 * rule's rationale — carrying the fully-clipped `modified_intent`.
 */
function combineClips(modified: Intent, clips: readonly RefereeResult[]): RefereeResult {
  const [first] = clips;
  if (clips.length === 1 && first !== undefined) return first;
  return {
    decision: 'CLIP',
    severity: 'soft',
    rule_fired: clips.map((c) => c.rule_fired).join('+'),
    detail: { clips: clips.map((c) => ({ rule: c.rule_fired, ...c.detail })) },
    modified_intent: modified,
    clipped: true,
  };
}

/**
 * Evaluate a validated Intent against the policy rule set (§6.3).
 *
 * Pure and deterministic: identical `(intent, state, config)` always yield the
 * identical result (and therefore the identical `policy_event`). Evaluation has
 * two phases (see {@link BLOCKING_RULES}/{@link CLIPPING_RULES}):
 *
 *  1. Blocking rules (HALT/REJECT) run first; the first one that fires decides
 *     outright. A terminal decision always dominates a soft clip, so no caller
 *     can pre-empt a REJECT/HALT by deliberately tripping an earlier CLIP.
 *  2. If nothing blocked, the clipping rules run and **accumulate** onto the
 *     intent: every breached cap is clamped in one CLIP, so clipping one field
 *     (e.g. size) can never let another (leverage, budget) slip through. When no
 *     rule fires the Intent is allowed unchanged.
 *
 * This function performs no IO. Structural re-validation (P0.3) and persisting
 * the `policy_event` belong to {@link runReferee} in `record.ts`.
 */
export function evaluate(
  intent: Intent,
  state: RefereeState,
  config: RefereeConfig,
): RefereeResult {
  for (const rule of BLOCKING_RULES) {
    const result = rule(intent, state, config);
    if (result !== null) return result;
  }

  let working = intent;
  const clips: RefereeResult[] = [];
  for (const rule of CLIPPING_RULES) {
    const result = rule(working, state, config);
    if (result !== null && result.modified_intent !== undefined) {
      working = result.modified_intent;
      clips.push(result);
    }
  }

  return clips.length > 0 ? combineClips(working, clips) : allow();
}
