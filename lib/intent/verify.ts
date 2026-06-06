import { getAddress, recoverMessageAddress, type Address } from 'viem';

import { canonicalPayload } from './canonical';
import { unsignedIntentSchema } from './schema';
import type { Intent } from './types';

/**
 * Intent signature verification (architecture.txt §8.2).
 *
 * The signature binds the canonical payload to the issuer's address. We recover
 * the signer from the EIP-191 signature over the *re-derived* canonical payload
 * (the Intent's unsigned fields), so any mutation of any field — or of the
 * signature — changes the recovered address and fails verification.
 */

/**
 * Recover the address that signed an Intent. Throws if the signature is
 * malformed or the Intent's unsigned fields fail to normalize.
 */
export async function recoverIntentSigner(intent: Intent): Promise<Address> {
  const { signature, ...rest } = intent;
  const unsigned = unsignedIntentSchema.parse(rest);
  return recoverMessageAddress({ message: canonicalPayload(unsigned), signature });
}

/**
 * Verify an Intent's signature against the agent's expected signer address.
 * Returns `false` (never throws) on any malformed/unrecoverable signature so the
 * validator can treat it as a clean rejection. Address comparison is checksum-
 * insensitive (both sides are normalized with {@link getAddress}).
 */
export async function verifyIntentSignature(
  intent: Intent,
  expectedSigner: Address,
): Promise<boolean> {
  let expected: Address;
  try {
    expected = getAddress(expectedSigner);
  } catch {
    return false;
  }
  try {
    const recovered = await recoverIntentSigner(intent);
    return getAddress(recovered) === expected;
  } catch {
    return false;
  }
}
