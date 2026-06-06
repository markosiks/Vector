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

/** Normalize a string/integer nonce to its canonical string form. */
export function normalizeNonce(nonce: string | number): string {
  if (typeof nonce === 'number') {
    if (!Number.isInteger(nonce)) throw new RangeError('numeric nonce must be an integer');
    return String(nonce);
  }
  if (nonce.length === 0) throw new RangeError('nonce must not be empty');
  return nonce;
}

/** Normalize an ISO-8601 string or epoch-ms number to ISO-8601 UTC. */
export function normalizeTimestamp(ttl: string | number): string {
  const date = typeof ttl === 'number' ? new Date(ttl) : new Date(ttl);
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
