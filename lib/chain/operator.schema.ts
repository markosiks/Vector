import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';

/**
 * Pure parsing/derivation for the on-chain signing keys (P1.7).
 *
 * Vector's two-key model (forced by the registry's self-feedback guard) uses two
 * distinct secp256k1 keys with the *same* shape:
 * - `OPERATOR_PRIVATE_KEY` — the **owner** key that registers seed agents in the
 *   Identity Registry (`msg.sender` becomes the agent owner).
 * - `ATTESTOR_PRIVATE_KEY` — a **separate** key that writes feedback. It must not
 *   own/operate the agents it attests, or `giveFeedback` reverts.
 *
 * This module is deliberately side-effect free and free of any `server-only`
 * guard so it can be unit/fuzz tested directly; the eager, server-only loaders
 * that read `ENV` live in `client.ts`.
 *
 * Security invariant: a raw key is never echoed. Every rejection references the
 * *variable name, reason and expected shape only* — never the offending value —
 * so a malformed (or real) key can never reach a log line or a client error.
 */

/** A 32-byte hex private key: `0x` + 64 hex chars. */
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/** Thrown when a signing key is missing or malformed. Carries no value. */
export class OperatorKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorKeyError';
  }
}

/**
 * Validate and normalize a raw signing key into a lowercased {@link Hex}.
 * Throws {@link OperatorKeyError} (value-free) on anything that is not a 32-byte
 * hex string. `varName` is used only to make the (redacted) error actionable.
 */
export function parseSignerKey(raw: string | undefined, varName: string): Hex {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new OperatorKeyError(`${varName} is required for on-chain writes`);
  }
  const trimmed = raw.trim();
  if (!PRIVATE_KEY_RE.test(trimmed)) {
    throw new OperatorKeyError(`${varName} must be a 0x-prefixed 32-byte hex string`);
  }
  return trimmed.toLowerCase() as Hex;
}

/** Parse the operator (agent-owner) key. */
export function parseOperatorKey(raw: string | undefined): Hex {
  return parseSignerKey(raw, 'OPERATOR_PRIVATE_KEY');
}

/** Parse the attestor (feedback-author) key. */
export function parseAttestorKey(raw: string | undefined): Hex {
  return parseSignerKey(raw, 'ATTESTOR_PRIVATE_KEY');
}

/** Derive a signer's public address from a validated key. */
export function operatorAddress(key: Hex): Address {
  return privateKeyToAccount(key).address;
}

/**
 * Assert the operator (owner) and attestor keys resolve to different addresses.
 * The registry rejects feedback authored by an agent's owner/operator, and the
 * operator key owns every registered seed agent, so a shared key would make
 * every `giveFeedback` revert. Pure (no ENV/network) so both branches are
 * directly testable; the server-only wrapper in `client.ts` feeds it `ENV`.
 */
export function assertDistinctSignerKeys(
  operatorKey: string | undefined,
  attestorKey: string | undefined,
): void {
  const owner = operatorAddress(parseOperatorKey(operatorKey));
  const attestor = operatorAddress(parseAttestorKey(attestorKey));
  if (owner === attestor) {
    throw new OperatorKeyError(
      'ATTESTOR_PRIVATE_KEY must differ from OPERATOR_PRIVATE_KEY (registry forbids self-feedback)',
    );
  }
}
