import { compareDecimal } from '@/lib/intent/canonical';

import type { ClipRule } from '../types';
import { clipNumericField } from './_shared';

/**
 * Rule 8 — Per-agent leverage cap.
 *
 * A trade whose `leverage` strictly exceeds `max_leverage` is clipped to the cap
 * (a `soft` modification); `leverage == max_leverage` is allowed. Only the trade
 * actions (`open`, `modify`) carry leverage.
 */
export const leverageCapRule: ClipRule = (intent, _state, config) => {
  // Narrow on the intent (not just the action) so `leverage` is in scope; only
  // `open`/`modify` carry it.
  if (intent.action !== 'open' && intent.action !== 'modify') return null;
  if (compareDecimal(intent.leverage, config.max_leverage) <= 0) return null;
  return {
    decision: 'CLIP',
    severity: 'soft',
    rule_fired: 'leverage_cap',
    detail: { original_leverage: intent.leverage, max_leverage: config.max_leverage },
    modified_intent: clipNumericField(intent, 'leverage', config.max_leverage),
    clipped: true,
  };
};
