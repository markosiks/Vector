import type { Intent } from '@/lib/intent/types';

import { resolveByrealMarket, type ByrealMarket } from './markets';

/**
 * Pure Byreal CLI command builders (P2.1).
 *
 * Every command is built as an **argv array**, never a shell string: the caller
 * ({@link import('./cli').runByrealCli}) passes it straight to the OS exec call
 * with no shell interpreter, so shell metacharacters in any field are inert —
 * there is no shell to inject into. As defense in depth this module still
 * validates each interpolated value: the coin comes only from the frozen
 * whitelist map (never raw `intent.market`), and every numeric field is checked
 * against a strict decimal grammar so a malformed value is a deterministic throw
 * rather than an argv smuggling vector.
 *
 * Scope ([CORE]): market open, market close, and TP/SL modify on whitelisted
 * markets, plus the read commands. Limit orders are not expressible from the
 * current Intent contract (it carries no price field) and are [ROADMAP]; a
 * `transfer` never reaches the rail (the referee blocks it) and has no builder.
 */

/** Strict decimal grammar: optional sign, digits, optional fractional part. */
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

/** A builder error — the Intent cannot be expressed as a safe CLI command. */
export class ByrealCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ByrealCommandError';
  }
}

/** Assert a value is a canonical decimal string; throw otherwise. */
function decimal(field: string, value: string): string {
  if (!DECIMAL.test(value)) {
    throw new ByrealCommandError(`byreal command: ${field} is not a decimal value`);
  }
  return value;
}

/** Map a Vector long/short side to the CLI's long/short side (passed through). */
function side(intentSide: 'long' | 'short'): string {
  return intentSide;
}

/** Append `--tp`/`--sl` flags when the Intent carries them (both optional). */
function tpSlFlags(intent: { tp?: string | undefined; sl?: string | undefined }): string[] {
  const flags: string[] = [];
  if (intent.tp !== undefined) flags.push('--tp', decimal('tp', intent.tp));
  if (intent.sl !== undefined) flags.push('--sl', decimal('sl', intent.sl));
  return flags;
}

/** The result of building a settlement command: the argv plus its market. */
export interface ByrealCommand {
  readonly argv: readonly string[];
  readonly market: ByrealMarket;
}

/**
 * Build the CLI argv that settles `intent` on the live venue, or `null` when the
 * Intent is not expressible on the Byreal rail ([CORE] scope) — an unmapped
 * market, a `transfer`, or a limit order. A `null` is the caller's signal to
 * defer to the deterministic seed fallback, never an error.
 *
 * @throws {@link ByrealCommandError} only when a *mapped* Intent carries a
 *   malformed numeric (size/tp/sl) — a structural fault, surfaced loudly.
 */
export function buildSettlementCommand(intent: Intent): ByrealCommand | null {
  // A transfer moves funds and never settles on the trading rail (the referee
  // already REJECTs it; this is the structural guarantee that the rail can never
  // move funds even if reached). No market, no order — defer.
  if (intent.action === 'transfer') return null;

  const market = resolveByrealMarket(intent.market);
  if (market === undefined) return null; // Not a Byreal market — defer to seed.

  const size = decimal('size', intent.size);

  if (intent.action === 'open') {
    return {
      market,
      argv: ['order', 'market', side(intent.side), size, market.coin, ...tpSlFlags(intent)],
    };
  }

  if (intent.action === 'modify') {
    // A position modify maps to setting TP/SL on the existing position. With no
    // TP/SL to set there is nothing to express on the venue — defer to seed.
    const flags = tpSlFlags(intent);
    if (flags.length === 0) return null;
    return { market, argv: ['position', 'tpsl', market.coin, ...flags] };
  }

  // close: a market close of `size` on the position. Partial when size < position.
  return { market, argv: ['position', 'close-market', market.coin, size] };
}

/** Argv for the public account read (balance, margin, unrealized PnL). */
export function buildAccountInfoCommand(): readonly string[] {
  return ['account', 'info'];
}

/** Argv for the open-positions read (size, entry, value, unrealized PnL). */
export function buildPositionListCommand(): readonly string[] {
  return ['position', 'list'];
}
