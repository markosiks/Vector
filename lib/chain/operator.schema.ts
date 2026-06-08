import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';

/**
 * Pure parsing/derivation for the operator signing key (P1.7).
 *
 * Deliberately side-effect free and free of any `server-only` guard so it can be
 * unit/fuzz tested directly; the eager, server-only loader that reads `ENV`
 * lives in `client.ts`.
 *
 * Security invariant: the raw key is never echoed. Every rejection references
 * the *reason and expected shape only* — never the offending value — so a
 * malformed (or real) key can never reach a log line or an error surfaced to a
 * client.
 */

/** A 32-byte hex private key: `0x` + 64 hex chars. */
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/** Thrown when the operator key is missing or malformed. Carries no value. */
export class OperatorKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorKeyError';
  }
}

/**
 * Validate and normalize a raw operator key into a lowercased {@link Hex}.
 * Throws {@link OperatorKeyError} (value-free) on anything that is not a
 * 32-byte hex string.
 */
export function parseOperatorKey(raw: string | undefined): Hex {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new OperatorKeyError('OPERATOR_PRIVATE_KEY is required for on-chain writes');
  }
  const trimmed = raw.trim();
  if (!PRIVATE_KEY_RE.test(trimmed)) {
    throw new OperatorKeyError('OPERATOR_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string');
  }
  return trimmed.toLowerCase() as Hex;
}

/** Derive the operator's public address from a validated key. */
export function operatorAddress(key: Hex): Address {
  return privateKeyToAccount(key).address;
}
