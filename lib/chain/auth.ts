import { getAddress, recoverMessageAddress, type Address, type Hex } from 'viem';

/**
 * Feedback authorization verification (P1.7, task 5).
 *
 * ## How the *live* canonical registry actually authorizes (VERIFY V2 fact)
 *
 * The deployed ERC-8004 Reputation Registry's `giveFeedback(...)` takes **no**
 * signature argument — authorization is by `msg.sender`. The author of a piece
 * of feedback is whichever address sent the transaction, and `getClients(agentId)`
 * enumerates those addresses. In Vector's operator model that sender is the
 * funded operator wallet (`OPERATOR_PRIVATE_KEY`), so the on-chain authorization
 * is simply the secp256k1 transaction signature — there is no separate
 * EIP-191/ERC-1271 "FeedbackAuth" layer in this contract version (that belonged
 * to an earlier ERC-8004 draft).
 *
 * ## Why these helpers still exist
 *
 * Vector also serves off-chain feedback detail (`feedback_uri`, integrity-anchored
 * by `feedback_hash`). Authenticating that off-chain payload — and staying
 * forward-compatible with signature-authorized feedback — uses the standard
 * EIP-191 (EOA) / ERC-1271 (smart-account) scheme. These helpers reuse viem's
 * primitives rather than re-implementing signature recovery, mirroring the
 * established `lib/intent/verify.ts` pattern. They never throw on a malformed
 * signature: a bad signature is a clean `false`, so a caller treats it as a
 * rejection.
 */

/** The minimal client capability needed for ERC-1271 (smart-account) checks. */
export interface SignatureVerifier {
  verifyMessage(args: { address: Address; message: string; signature: Hex }): Promise<boolean>;
}

/**
 * Verify an EIP-191 (`personal_sign`) authorization offline: recover the signer
 * from the signature over `message` and compare it, checksum-insensitively, to
 * `expectedSigner`. Returns `false` on any malformed input. Deterministic and
 * network-free, so it is the unit/fuzz-tested core.
 */
export async function verifyEip191Authorization(
  message: string,
  signature: Hex,
  expectedSigner: string,
): Promise<boolean> {
  let expected: Address;
  try {
    expected = getAddress(expectedSigner);
  } catch {
    return false;
  }
  try {
    const recovered = await recoverMessageAddress({ message, signature });
    return getAddress(recovered) === expected;
  } catch {
    return false;
  }
}

/**
 * Verify an authorization signature for `expectedSigner`, supporting both EOA
 * (EIP-191) and smart-contract (ERC-1271) signers. Delegates to viem's
 * `verifyMessage`, which performs ERC-1271 `isValidSignature` resolution against
 * the chain when the signer is a contract and falls back to EIP-191 recovery for
 * an EOA. Returns `false` (never throws) on any malformed/unverifiable input.
 */
export async function verifyAuthorization(
  verifier: SignatureVerifier,
  message: string,
  signature: Hex,
  expectedSigner: string,
): Promise<boolean> {
  let expected: Address;
  try {
    expected = getAddress(expectedSigner);
  } catch {
    return false;
  }
  try {
    return await verifier.verifyMessage({ address: expected, message, signature });
  } catch {
    return false;
  }
}
