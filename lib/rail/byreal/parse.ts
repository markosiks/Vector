import { z } from 'zod';

import type { ExecutionStatus } from '@/lib/db/schema';
import type { SeedOutcome } from '@/seed';

import { ByrealParseError } from './envelope';

/**
 * Map a Byreal CLI payload (`envelope.data`) onto Vector's execution/outcome
 * shape (P2.1).
 *
 * Two layers of strictness, matched to how the values are used:
 *  - The **order result** must yield at least an order id and a fill status —
 *    without those there is no settlement to record, so a missing/garbled result
 *    is a {@link ByrealParseError} and the caller falls back to the seed.
 *  - The **economics** (PnL, fees, capital-at-risk, drawdown) are *credibility*
 *    figures that never feed the deterministic score (the boundary, §3), so a
 *    missing/unparseable secondary field defaults to `'0'` rather than failing
 *    the whole settle — we record the verifiable order with zeroed economics
 *    instead of discarding a real fill.
 *
 * All numerics are normalised to canonical decimal strings (the `numeric`
 * column contract); they are never bound through a float.
 */

/** Coerce a CLI numeric (string or finite number) to a canonical decimal string. */
function toDecimal(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(trimmed) ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Lenient numeric: a parseable decimal, else `'0'` (credibility figures). */
const decOr0 = (value: unknown): string => toDecimal(value) ?? '0';

/** Absolute value of a decimal string, preserving the canonical form. */
function absDecimal(value: string): string {
  return value.startsWith('-') ? value.slice(1) : value;
}

/** Negate a decimal string. */
function negateDecimal(value: string): string {
  if (value === '0') return '0';
  return value.startsWith('-') ? value.slice(1) : `-${value}`;
}

// --- Order result -----------------------------------------------------------

const orderIdSchema = z.union([z.string(), z.number()]).transform((v) => String(v));

/**
 * A Byreal order result. Permissive on the envelope's `data`: the CLI nests the
 * fill under `filled`/`resting` and surfaces an order id under several keys
 * across commands/versions, so we accept the documented aliases and validate
 * defensively rather than pin one exact shape (confirmed against the live
 * account/error envelopes; the order payload is modeled from the CLI catalog).
 */
const orderResultSchema = z
  .object({
    filled: z
      .object({ oid: orderIdSchema.optional(), totalSz: z.unknown(), avgPx: z.unknown() })
      .passthrough()
      .optional(),
    resting: z.object({ oid: orderIdSchema.optional() }).passthrough().optional(),
    oid: orderIdSchema.optional(),
    orderId: orderIdSchema.optional(),
    status: z.string().optional(),
    closedPnl: z.unknown().optional(),
    realizedPnl: z.unknown().optional(),
    fee: z.unknown().optional(),
    fees: z.unknown().optional(),
  })
  .passthrough();

/** The normalized result of one order command. */
export interface OrderFill {
  readonly orderId: string;
  readonly status: ExecutionStatus;
  /** Absolute filled size (coin units), `'0'` when nothing filled (resting). */
  readonly filledSize: string;
  /** Realized PnL booked by this order (non-zero only on closes). */
  readonly realizedPnl: string;
  /** Fee charged on the fill. */
  readonly fees: string;
}

/**
 * Parse an order command's `data` into an {@link OrderFill}.
 *
 * @throws {@link ByrealParseError} when no order id can be found — there is no
 *   settlement to record and the caller falls back to the seed.
 */
export function parseOrderResult(data: unknown): OrderFill {
  const parsed = orderResultSchema.safeParse(data);
  if (!parsed.success) {
    throw new ByrealParseError('byreal order result is not a recognized shape');
  }
  const r = parsed.data;
  const orderId = r.filled?.oid ?? r.resting?.oid ?? r.oid ?? r.orderId;
  if (orderId === undefined) {
    throw new ByrealParseError('byreal order result carries no order id');
  }

  const filledSize = r.filled === undefined ? '0' : absDecimal(decOr0(r.filled.totalSz));
  const hasFill = filledSize !== '0';
  const hasResting = r.resting !== undefined;
  const status: ExecutionStatus = hasFill
    ? hasResting
      ? 'partial'
      : 'filled'
    : hasResting
      ? 'sent'
      : 'filled';

  return {
    orderId,
    status,
    filledSize,
    realizedPnl: decOr0(r.closedPnl ?? r.realizedPnl),
    fees: decOr0(r.fee ?? r.fees),
  };
}

// --- Position read ----------------------------------------------------------

const positionSchema = z
  .object({
    coin: z.string().optional(),
    szi: z.unknown().optional(),
    positionValue: z.unknown().optional(),
    unrealizedPnl: z.unknown().optional(),
    marginUsed: z.unknown().optional(),
  })
  .passthrough();

/** Position list `data`: an array, or an object wrapping `{ positions: [...] }`. */
const positionListSchema = z.union([
  z.array(positionSchema),
  z.object({ positions: z.array(positionSchema) }).passthrough(),
]);

/** A normalized open position for `coin`. */
export interface OpenPosition {
  /** Notional position value (capital at risk), absolute. */
  readonly notional: string;
  /** Marked (unrealized) PnL. */
  readonly markedPnl: string;
  /** Signed position size (coin units): negative for a short. */
  readonly size: string;
}

/** Find and normalize the open position for `coin`, or `undefined` if flat. */
export function findPosition(data: unknown, coin: string): OpenPosition | undefined {
  const parsed = positionListSchema.safeParse(data);
  if (!parsed.success) return undefined;
  const list = Array.isArray(parsed.data) ? parsed.data : parsed.data.positions;
  const match = list.find((p) => p.coin === coin);
  if (match === undefined) return undefined;
  return {
    notional: absDecimal(decOr0(match.positionValue)),
    markedPnl: decOr0(match.unrealizedPnl),
    size: decOr0(match.szi),
  };
}

// --- Outcome assembly -------------------------------------------------------

/** Inputs to {@link buildOutcome}: the order fill plus an optional position read. */
export interface OutcomeParts {
  readonly order: OrderFill;
  readonly position?: OpenPosition | undefined;
  /** Intent side for an open (sets the position-delta sign); absent on a close. */
  readonly openSide?: 'long' | 'short' | undefined;
  /** True when this settles a close (reduces the position). */
  readonly isClose: boolean;
}

/**
 * Assemble the {@link SeedOutcome}-shaped outcome row from a settled order and
 * (optionally) the resulting position read.
 *
 * - `capital_at_risk` — the position's notional when read, else the fill notional
 *   is unknown from the order result alone, so `'0'` (documented; credibility).
 * - `pnl_marked` — the position's unrealized PnL (read), else `'0'`.
 * - `pnl_realized` — booked by the order (closes only).
 * - `position_delta` — signed filled size: an open takes the intent's side; a
 *   close reduces the position (negative of the filled size).
 * - `drawdown` — not derivable per-fill from the venue; `'0'` by contract (it is
 *   a scoring-only quantity and Byreal outcomes never feed the score).
 */
export function buildOutcome(parts: OutcomeParts): SeedOutcome {
  const { order, position, openSide, isClose } = parts;
  const positionDelta = isClose
    ? negateDecimal(order.filledSize)
    : openSide === 'short'
      ? negateDecimal(order.filledSize)
      : order.filledSize;

  return {
    pnl_realized: order.realizedPnl,
    pnl_marked: position?.markedPnl ?? '0',
    capital_at_risk: position?.notional ?? '0',
    fees: order.fees,
    position_delta: positionDelta,
    drawdown: '0',
  };
}
