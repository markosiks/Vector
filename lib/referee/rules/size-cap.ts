import { compareDecimal } from '@/lib/intent/canonical';
import { isTradeAction } from '@/lib/intent/types';

import type { Rule } from '../types';
import { clipNumericField } from './_shared';

/**
 * Rule 4 — Per-trade size cap.
 *
 * A trade whose `size` strictly exceeds `max_trade_size` is clipped down to the
 * cap (a `soft` modification). `size == max_trade_size` is allowed. Applies to
 * the trade actions that establish exposure (`open`, `modify`); a `close`
 * reduces exposure and a `transfer` is handled by the transfer-block rule.
 */
export const sizeCapRule: Rule = (intent, _state, config) => {
  if (!isTradeAction(intent.action)) return null;
  if (compareDecimal(intent.size, config.max_trade_size) <= 0) return null;
  return {
    decision: 'CLIP',
    severity: 'soft',
    rule_fired: 'size_cap',
    detail: { original_size: intent.size, max_trade_size: config.max_trade_size },
    modified_intent: clipNumericField(intent, 'size', config.max_trade_size),
    clipped: true,
  };
};
