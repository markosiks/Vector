import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';

import { canonicalPayload } from './canonical';
import { unsignedIntentSchema } from './schema';
import type { Intent, UnsignedIntentInput } from './types';

/**
 * Intent signing (issuer/harness side, architecture.txt §8.2).
 *
 * Keys live only with the issuer/harness, never with agent strategy logic (§4.3
 * of the P0.3 spec): an agent proposes an unsigned Intent, the harness signs its
 * canonical payload. Signing is over the canonical string via EIP-191
 * (`personal_sign`); ERC-1271 contract-account signatures are ROADMAP.
 *
 * The input is normalized through {@link unsignedIntentSchema} before signing so
 * the signed bytes always match what {@link verifyIntentSignature} re-derives.
 */

/** The address that a private key signs as. */
export function signerAddress(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
}

/**
 * Normalize and sign an unsigned Intent, returning a signed {@link Intent}.
 * Throws if the input fails structural validation (so a malformed Intent is
 * never signed).
 */
export async function signIntent(input: UnsignedIntentInput, privateKey: Hex): Promise<Intent> {
  const unsigned = unsignedIntentSchema.parse(input);
  const account = privateKeyToAccount(privateKey);
  const signature = await account.signMessage({ message: canonicalPayload(unsigned) });
  return { ...unsigned, signature } as Intent;
}
