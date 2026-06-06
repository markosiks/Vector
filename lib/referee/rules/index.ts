import type { Rule } from '../types';
import { drawdownBreakerRule } from './drawdown-breaker';
import { killSwitchRule } from './kill-switch';
import { leverageCapRule } from './leverage-cap';
import { marketWhitelistRule } from './market-whitelist';
import { sizeCapRule } from './size-cap';
import { spendCapRule } from './spend-cap';
import { transferBlockRule } from './transfer-block';

/**
 * The ordered policy rule set (architecture §6.3). Order is the single source of
 * truth: the first rule that fires decides, so this array — not any per-rule
 * priority field — defines precedence. Do not reorder without updating
 * `docs/referee.md` and the ordering tests.
 *
 *   1. kill switch        → HALT everything
 *   2. market whitelist   → REJECT (hard)
 *   3. transfer block     → REJECT (hard)   ← the drain block
 *   4. per-trade size cap → CLIP (soft)
 *   5. spend cap          → CLIP / REJECT (soft)
 *   6. leverage cap       → CLIP (soft)
 *   7. drawdown breaker   → HALT (halt)
 */
export const RULES: readonly Rule[] = [
  killSwitchRule,
  marketWhitelistRule,
  transferBlockRule,
  sizeCapRule,
  spendCapRule,
  leverageCapRule,
  drawdownBreakerRule,
];

export {
  drawdownBreakerRule,
  killSwitchRule,
  leverageCapRule,
  marketWhitelistRule,
  sizeCapRule,
  spendCapRule,
  transferBlockRule,
};
