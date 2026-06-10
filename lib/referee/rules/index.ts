import type { ClipRule, Rule } from '../types';
import { agentHaltRule } from './agent-halt';
import { drawdownBreakerRule } from './drawdown-breaker';
import { killSwitchRule } from './kill-switch';
import { leverageCapRule } from './leverage-cap';
import { marketWhitelistRule } from './market-whitelist';
import { sizeCapRule } from './size-cap';
import { spendCapClipRule, spendCapRejectRule } from './spend-cap';
import { transferBlockRule } from './transfer-block';

/**
 * The policy rule set in two phases (architecture §6.3).
 *
 * Order is the single source of truth. The split exists for a safety reason: a
 * terminal decision (HALT/REJECT) must always dominate a soft CLIP. If all rules
 * ran in one "first-fires-decides" list, an attacker could deliberately trip an
 * early CLIP (e.g. oversize the trade) to pre-empt a later REJECT/HALT and slip
 * an over-leveraged / over-budget / drawdown-breached trade through. So:
 *
 *  - {@link BLOCKING_RULES} run first; the first one that fires decides outright.
 *  - {@link CLIPPING_RULES} run only if no blocking rule fired; they *accumulate*,
 *    so every breached cap is clamped in one CLIP (no cap can be skipped).
 *
 * Do not reorder or move a rule between phases without updating `docs/referee.md`
 * and the ordering tests.
 *
 * Blocking (terminal):
 *   1.  kill switch           → HALT  (global operator override, dominates everything)
 *   1b. per-agent halt        → HALT  (operator HALT of one agent, P2.4)
 *   2.  market whitelist      → REJECT/hard
 *   3.  transfer block        → REJECT/hard   ← the drain block
 *   4.  drawdown breaker      → HALT   (agent frozen for the round)
 *   5.  spend cap (no budget) → REJECT/soft
 * Clipping (accumulating, all soft):
 *   6.  per-trade size cap    → clamp size → max_trade_size
 *   7.  spend cap (over budget)→ clamp size → remaining_budget
 *   8.  per-agent leverage cap → clamp leverage → max_leverage
 */
export const BLOCKING_RULES: readonly Rule[] = [
  killSwitchRule,
  agentHaltRule,
  marketWhitelistRule,
  transferBlockRule,
  drawdownBreakerRule,
  spendCapRejectRule,
];

export const CLIPPING_RULES: readonly ClipRule[] = [sizeCapRule, spendCapClipRule, leverageCapRule];

export {
  agentHaltRule,
  drawdownBreakerRule,
  killSwitchRule,
  leverageCapRule,
  marketWhitelistRule,
  sizeCapRule,
  spendCapClipRule,
  spendCapRejectRule,
  transferBlockRule,
};
