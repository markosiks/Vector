import { keccak256, stringToBytes, type Hex } from 'viem';

import type { UnsignedIntent } from './schema';

/**
 * Deterministic canonicalization of an Intent payload.
 *
 * The signature and `intent_hash` are taken over the *canonical payload*: a
 * byte-for-byte reproducible serialization of the Intent's unsigned fields. Two
 * logically-identical Intents must yield the same bytes on any platform, so the
 * canonical form fixes every source of ambiguity:
 *
 *  - object keys are emitted in lexicographic order (`stableStringify`);
 *  - numbers are normalized to a canonical decimal string (`normalizeDecimal`),
 *    so `1`, `1.0`, and `"1"` collapse to the same token and there is no
 *    exponent/locale/trailing-zero drift;
 *  - timestamps are normalized to ISO-8601 UTC (`normalizeTimestamp`);
 *  - the `signature` field is excluded (you sign the payload, not the signature);
 *  - absent optional fields are omitted entirely (never serialized as `null`),
 *    so presence is unambiguous.
 *
 * Reference: architecture.txt §8.2 (schema) and §6.3 (the referee validates the
 * canonical typed Intent, never raw text).
 */

/** Maximum digits accepted in a single decimal literal — guards pathological input. */
const MAX_DECIMAL_DIGITS = 80;

const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * Normalize a number or decimal string to a canonical decimal string: no
 * exponent, no leading zeros (except a single `0`), no trailing fraction zeros,
 * and no signed zero. Throws {@link RangeError} on non-finite or non-decimal
 * input so a malformed numeric is rejected deterministically at the boundary.
 */
export function normalizeDecimal(input: number | string): string {
  if (typeof input === 'number' && !Number.isFinite(input)) {
    throw new RangeError('numeric value must be finite');
  }
  const raw = (typeof input === 'number' ? String(input) : input).trim();
  const m = DECIMAL_RE.exec(raw);
  const intDigits = m?.[2] ?? '';
  const fracDigits = m?.[3] ?? '';
  if (!m || (intDigits === '' && fracDigits === '')) {
    throw new RangeError(`invalid decimal literal: ${JSON.stringify(input)}`);
  }
  if (intDigits.length + fracDigits.length > MAX_DECIMAL_DIGITS) {
    throw new RangeError('decimal literal exceeds maximum precision');
  }

  const sign = m[1] === '-' ? '-' : '';
  const digits = intDigits + fracDigits;
  // Position of the decimal point within `digits`, shifted by any exponent.
  const pointPos = intDigits.length + (m[4] ? parseInt(m[4], 10) : 0);

  // Guard against exponent-driven expansion: a tiny literal like "1e8000000"
  // has few significant digits (so it slips past the digit cap above) yet would
  // expand to millions of positional zeros below, allocating gigabytes from a
  // handful of input bytes. This runs at schema-parse, *before* signature
  // verification, so it is an unauthenticated amplification DoS. Bound the full
  // positional span (leading integer + trailing fractional places) by the same
  // precision cap, rejecting the literal deterministically instead.
  const span = Math.max(pointPos, digits.length) - Math.min(pointPos, 0);
  if (span > MAX_DECIMAL_DIGITS) {
    throw new RangeError('decimal magnitude exceeds maximum precision');
  }

  let intPart: string;
  let fracPart: string;
  if (pointPos <= 0) {
    intPart = '0';
    fracPart = '0'.repeat(-pointPos) + digits;
  } else if (pointPos >= digits.length) {
    intPart = digits + '0'.repeat(pointPos - digits.length);
    fracPart = '';
  } else {
    intPart = digits.slice(0, pointPos);
    fracPart = digits.slice(pointPos);
  }

  intPart = intPart.replace(/^0+(?=\d)/, '');
  fracPart = fracPart.replace(/0+$/, '');

  const out = fracPart ? `${intPart}.${fracPart}` : intPart;
  // Collapse every representation of zero (incl. "-0", "0.0") to a single "0".
  return /^0(\.0*)?$/.test(out) ? '0' : sign + out;
}

/**
 * Compare two decimals by value, exactly and without ever touching a float.
 *
 * Inputs may be numbers or strings; each is run through {@link normalizeDecimal}
 * first, so a caller can compare a config literal (`max_trade_size: 10_000`)
 * against a signed Intent's canonical decimal string (`"10000.0000001"`) and get
 * the right answer at full precision — a `Number()` round-trip would collapse
 * that excess and admit a value strictly over the cap. Returns `-1`, `0`, or `1`
 * for `a < b`, `a === b`, `a > b`.
 *
 * Relies on the canonical form's guarantees (single `0`, no leading integer
 * zeros, no trailing fraction zeros, leading `-` only for negatives) so integer
 * magnitudes compare first by digit count, then lexicographically.
 */
export function compareDecimal(a: number | string, b: number | string): -1 | 0 | 1 {
  const na = normalizeDecimal(a);
  const nb = normalizeDecimal(b);
  if (na === nb) return 0;
  const aNeg = na.startsWith('-');
  const bNeg = nb.startsWith('-');
  if (aNeg !== bNeg) return aNeg ? -1 : 1;
  const mag = compareMagnitude(aNeg ? na.slice(1) : na, bNeg ? nb.slice(1) : nb);
  return aNeg ? ((mag * -1) as -1 | 0 | 1) : mag;
}

/** Compare two non-negative canonical decimal strings by magnitude. */
function compareMagnitude(a: string, b: string): -1 | 0 | 1 {
  const aDot = a.indexOf('.');
  const bDot = b.indexOf('.');
  const aInt = aDot === -1 ? a : a.slice(0, aDot);
  const bInt = bDot === -1 ? b : b.slice(0, bDot);
  // Canonical integer parts carry no leading zeros, so more digits ⇒ larger.
  if (aInt.length !== bInt.length) return aInt.length < bInt.length ? -1 : 1;
  if (aInt !== bInt) return aInt < bInt ? -1 : 1;
  const aFrac = aDot === -1 ? '' : a.slice(aDot + 1);
  const bFrac = bDot === -1 ? '' : b.slice(bDot + 1);
  const width = Math.max(aFrac.length, bFrac.length);
  const aPad = aFrac.padEnd(width, '0');
  const bPad = bFrac.padEnd(width, '0');
  if (aPad === bPad) return 0;
  return aPad < bPad ? -1 : 1;
}

/**
 * Normalize a string/integer nonce to its canonical string form.
 *
 * A numeric nonce must be a *safe* integer: beyond `Number.MAX_SAFE_INTEGER` a
 * JSON number has already lost precision before it reaches us, so two distinct
 * large nonces can collapse to the same canonical string (e.g. `2^53+1` →
 * `"9007199254740992"`) and alias each other in the anti-replay key, wrongly
 * rejecting a legitimate Intent as a replay. Such values are rejected so callers
 * use a string nonce for large/opaque values.
 */
export function normalizeNonce(nonce: string | number): string {
  if (typeof nonce === 'number') {
    if (!Number.isInteger(nonce)) throw new RangeError('numeric nonce must be an integer');
    if (!Number.isSafeInteger(nonce)) {
      throw new RangeError('numeric nonce exceeds safe-integer range; use a string nonce');
    }
    return String(nonce);
  }
  if (nonce.length === 0) throw new RangeError('nonce must not be empty');
  return nonce;
}

/**
 * Strict ISO-8601 *instant* with a mandatory timezone designator (`Z` or
 * `±HH:MM`/`±HHMM`). A timezone-less datetime is deliberately rejected: per
 * ECMA-262 `new Date("2030-01-01T00:00:00")` is interpreted in the host's local
 * zone, so `toISOString()` would yield host-dependent bytes and break the
 * byte-for-byte reproducibility the canonical payload exists to guarantee.
 */
const ISO_8601_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Normalize a timestamp to ISO-8601 UTC. A `number` is treated as epoch
 * milliseconds; a `string` must be a strict ISO-8601 instant carrying an
 * explicit timezone (see {@link ISO_8601_INSTANT_RE}). Lenient,
 * implementation-defined `Date` parsing of arbitrary strings (locale dates, bare
 * years, timezone-less datetimes) is rejected so the result is deterministic and
 * identical across hosts and runtimes.
 */
export function normalizeTimestamp(ttl: string | number): string {
  if (typeof ttl === 'string' && !ISO_8601_INSTANT_RE.test(ttl)) {
    throw new RangeError(`timestamp must be ISO-8601 with a timezone: ${JSON.stringify(ttl)}`);
  }
  const date = new Date(ttl);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) throw new RangeError(`invalid timestamp: ${JSON.stringify(ttl)}`);
  return date.toISOString();
}

/**
 * Stable JSON: object keys sorted lexicographically at every depth, `undefined`
 * omitted. Used only on already-normalized, JSON-safe values.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * The canonical payload string for an Intent's unsigned fields. Operates on an
 * already-normalized {@link UnsignedIntent} (the schema parse produces canonical
 * numeric/timestamp values), so signing and verification derive identical bytes.
 */
export function canonicalPayload(intent: UnsignedIntent): string {
  // `intent` is already normalized by the schema; strip any stray `signature`
  // and serialize the remaining present fields deterministically.
  const fields: Record<string, unknown> = { ...intent };
  delete fields.signature;
  return stableStringify(fields);
}

/** KECCAK-256 of the canonical payload, as a `0x`-prefixed 32-byte hex string. */
export function intentHash(intent: UnsignedIntent): Hex {
  return keccak256(stringToBytes(canonicalPayload(intent)));
}
