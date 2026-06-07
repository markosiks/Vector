import { compareDecimal, normalizeDecimal } from '@/lib/intent/canonical';
import type { Context, Decide, UnsignedIntentInput } from '@/lib/intent/types';

/**
 * Deterministic seed-agent strategies for the demo spine (architecture.txt §8.1,
 * §6.5).
 *
 * A seed agent's `decide` is a **pure, deterministic** function of its read-only
 * {@link Context}: same context ⇒ same proposed Intent, with no clock and no
 * randomness. That is what lets the whole arc replay bit-for-bit. The strategy
 * only proposes the *trade* (market, side, size, leverage) — the harness stamps
 * the authoritative `nonce`/`ttl` and signs (P1.4 `compose`/`orchestrator`),
 * because an agent holds no credentials and must not control anti-replay (§4.3).
 * The `nonce`/`ttl` returned here are schema-valid placeholders the harness
 * overwrites; they never reach a signature.
 *
 * Sizing is clamped to the agent's `remaining_budget` so a seed agent never
 * proposes beyond its allocation, but the strategy intentionally does **not**
 * reimplement the referee's caps (`max_trade_size`, `max_leverage`): emitting an
 * over-cap Intent and letting the referee CLIP it is a valid, observable path.
 * Seed strategies are tuned to stay within caps so the clean arc shows ALLOWs.
 */

/** Placeholder anti-replay fields; the harness re-stamps both before signing. */
const PLACEHOLDER_NONCE = '0';
const PLACEHOLDER_TTL = '2099-01-01T00:00:00.000Z';

/** Frozen parameters that define one seed agent's trading behaviour. */
export interface SeedStrategyParams {
  /** Whitelisted market the agent trades (e.g. `BTC-PERP`). */
  readonly market: string;
  /** Position side. */
  readonly side: 'long' | 'short';
  /** Notional size per Intent, canonical decimal string (clamped to budget). */
  readonly size: string;
  /** Leverage, canonical decimal string. */
  readonly leverage: string;
  /** Max slippage in `[0, 1]`, canonical decimal string. */
  readonly max_slippage: string;
}

/**
 * Build a deterministic `open`-position strategy from frozen params. The
 * proposed size is `min(params.size, remaining_budget)`; when the budget is
 * exhausted (`remaining_budget == 0`) the agent still proposes its base size so
 * the cold-start round — where no budget has been allocated yet — produces a
 * real Intent rather than a degenerate zero-size one the validator would reject.
 */
export function createTradeStrategy(params: SeedStrategyParams): Decide {
  const baseSize = normalizeDecimal(params.size);
  const leverage = normalizeDecimal(params.leverage);
  const maxSlippage = normalizeDecimal(params.max_slippage);

  return (context: Context): UnsignedIntentInput => {
    const budget = normalizeDecimal(context.remaining_budget);
    const size = budget !== '0' && compareDecimal(budget, baseSize) < 0 ? budget : baseSize;

    return {
      action: 'open',
      agent_id: context.agent_id,
      market: params.market,
      side: params.side,
      size,
      leverage,
      max_slippage: maxSlippage,
      nonce: PLACEHOLDER_NONCE,
      ttl: PLACEHOLDER_TTL,
    };
  };
}
