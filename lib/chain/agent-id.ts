/**
 * On-chain agentId provenance for ERC-8004 feedback (P1.7 task 5, corrected).
 *
 * ## Ground truth (verified against the live Mantle Sepolia contracts)
 *
 * An ERC-8004 Reputation Registry keys every feedback entry by `agentId`, which
 * is the **ERC-721 tokenId minted by the Identity Registry**. The canonical
 * `giveFeedback(...)` calls `IIdentityRegistry.isAuthorizedOrOwner(msg.sender,
 * agentId)` and reverts with `ERC721NonexistentToken` when `agentId` was never
 * registered. There is therefore **no such thing as an operator-invented
 * agentId**: a write against an unregistered id always reverts.
 *
 * An earlier revision of this module handed each seed agent a 1-based id
 * (`1, 2, 3, …`). On the canonical registry those tokenIds are **already owned
 * by an unrelated party** (e.g. `ownerOf(1)` → `0x3D75…`), so writing feedback
 * against them would attest *someone else's* agent. That footgun is removed
 * here: a seed agent has **no** on-chain id until it is really registered, which
 * matches the data model (`agents.agent_id_onchain` is "nullable until
 * registered", §7.1). Registration is performed via {@link registerAgent}
 * (lib/chain/identity.ts) and the returned tokenId is persisted into
 * `agents.agent_id_onchain`; this module only *validates* that stored value on
 * the way back out, so the feedback write path (P1.8) fails closed rather than
 * inventing or reusing an id.
 */

/** Inclusive upper bound of a Solidity `uint256` (ERC-721 tokenId domain). */
const UINT256_MAX = (1n << 256n) - 1n;

/** Thrown when a stored on-chain agentId is missing or malformed. Value-free. */
export class AgentIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentIdError';
  }
}

/**
 * Validate a persisted `agents.agent_id_onchain` into a `uint256` tokenId.
 *
 * `null`/empty means the agent has not been registered in the Identity Registry
 * yet — a hard precondition for any feedback write — so this throws rather than
 * substituting a placeholder. A non-decimal or out-of-range value is likewise a
 * deterministic {@link AgentIdError}. Existence of the tokenId on-chain is a
 * separate check ({@link agentExists} in lib/chain/identity.ts); this function
 * only guarantees the value is a well-formed candidate.
 */
export function parseOnchainAgentId(value: string | null | undefined): bigint {
  if (value === null || value === undefined || value.trim().length === 0) {
    throw new AgentIdError(
      'agent is not registered on-chain (agent_id_onchain is null); register it in the Identity Registry before writing feedback',
    );
  }
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new AgentIdError('agent_id_onchain must be a decimal uint256 string');
  }
  const id = BigInt(trimmed);
  if (id > UINT256_MAX) {
    throw new AgentIdError('agent_id_onchain out of uint256 range');
  }
  return id;
}

/**
 * Best-effort, non-throwing variant: returns the parsed tokenId, or `null` when
 * the agent has no valid registered id yet. Useful for read/display paths that
 * must tolerate not-yet-registered agents (the write path uses the strict
 * {@link parseOnchainAgentId} so it fails closed).
 */
export function tryOnchainAgentId(value: string | null | undefined): bigint | null {
  try {
    return parseOnchainAgentId(value);
  } catch {
    return null;
  }
}
