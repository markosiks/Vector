import {
  type Address,
  type Hex,
  hashMessage,
  encodePacked,
  keccak256,
  recoverAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * ERC-8004 Feedback Authorization helpers (EIP-191).
 *
 * In the ERC-8004 Reputation Registry, the server agent (or its operator)
 * signs an authorization granting a specific `clientAddress` the right to
 * submit feedback for a given `agentId`. This prevents spam — only authorized
 * clients can call `giveFeedback`.
 *
 * Vector's [CORE] model:
 * - The **operator** (OPERATOR_PRIVATE_KEY) controls the seed agents.
 * - The operator signs feedback authorizations via EIP-191.
 * - The operator's address is the `from` / `clientAddress` for `giveFeedback`.
 *
 * ## EIP-191 vs ERC-1271
 *
 * - **EIP-191** (Ethereum Signed Message): for EOA signers. The operator is an
 *   EOA, so this is the primary path.
 * - **ERC-1271** (`isValidSignature`): for smart-contract wallets. Supported by
 *   the registry but not used in [CORE] since the operator is an EOA.
 *
 * The authorization message format follows the ERC-8004 specification:
 * `keccak256(abi.encodePacked(agentId, clientAddress, maxFeedbackIndex, expiry))`
 * signed with EIP-191 personal_sign.
 */

export interface FeedbackAuthorization {
  /** The ERC-8004 agentId (tokenId) being authorized for feedback. */
  agentId: bigint;
  /** The address authorized to submit feedback. */
  clientAddress: Address;
  /** Maximum feedbackIndex (inclusive) this authorization covers. */
  maxFeedbackIndex: bigint;
  /** Unix timestamp (seconds) after which this authorization expires. */
  expiry: bigint;
  /** The EIP-191 signature over the authorization message. */
  signature: Hex;
  /** The address that produced the signature (the operator / agent owner). */
  signer: Address;
}

/**
 * Compute the authorization digest per ERC-8004.
 *
 * The digest is `keccak256(abi.encodePacked(agentId, clientAddress,
 * maxFeedbackIndex, expiry))`. The EIP-191 `personal_sign` wraps this with
 * `\x19Ethereum Signed Message:\n32`.
 */
export function feedbackAuthDigest(
  agentId: bigint,
  clientAddress: Address,
  maxFeedbackIndex: bigint,
  expiry: bigint,
): Hex {
  return keccak256(
    encodePacked(
      ['uint256', 'address', 'uint64', 'uint256'],
      [agentId, clientAddress, maxFeedbackIndex, expiry],
    ),
  );
}

/**
 * Sign a feedback authorization using EIP-191 `personal_sign`.
 *
 * @param operatorPrivateKey The operator's private key (hex, with 0x prefix).
 * @param params Authorization parameters.
 * @returns A complete {@link FeedbackAuthorization} with signature and signer.
 */
export async function signFeedbackAuth(
  operatorPrivateKey: Hex,
  params: {
    agentId: bigint;
    clientAddress: Address;
    maxFeedbackIndex: bigint;
    expiry: bigint;
  },
): Promise<FeedbackAuthorization> {
  const account = privateKeyToAccount(operatorPrivateKey);
  const digest = feedbackAuthDigest(
    params.agentId,
    params.clientAddress,
    params.maxFeedbackIndex,
    params.expiry,
  );

  // EIP-191 personal_sign: prefix + hash
  const signature = await account.signMessage({ message: { raw: digest } });

  return {
    agentId: params.agentId,
    clientAddress: params.clientAddress,
    maxFeedbackIndex: params.maxFeedbackIndex,
    expiry: params.expiry,
    signature,
    signer: account.address,
  };
}

/**
 * Verify a feedback authorization signature (EIP-191).
 *
 * @returns `true` if the recovered signer matches `expectedSigner`.
 */
export async function verifyFeedbackAuth(
  auth: Omit<FeedbackAuthorization, 'signer'>,
  expectedSigner: Address,
): Promise<boolean> {
  const digest = feedbackAuthDigest(
    auth.agentId,
    auth.clientAddress,
    auth.maxFeedbackIndex,
    auth.expiry,
  );

  try {
    const recovered = await recoverAddress({
      hash: hashMessage({ raw: digest }),
      signature: auth.signature,
    });
    return recovered.toLowerCase() === expectedSigner.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Check whether an authorization has expired.
 *
 * @param expiry Unix timestamp in seconds.
 * @param nowSeconds Current time in seconds (default: `Date.now() / 1000`).
 */
export function isAuthExpired(expiry: bigint, nowSeconds?: number): boolean {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  return expiry <= BigInt(now);
}
