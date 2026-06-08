/**
 * ERC-8004 Reputation Registry — canonical ABI subset used by Vector.
 *
 * Only the functions and events Vector actually calls are included.
 * Full ABI is at github.com/erc-8004/erc-8004-contracts/abis/.
 *
 * Source of truth: EIP-8004 specification (eips.ethereum.org/EIPS/eip-8004)
 * and the QuickNode ERC-8004 Explorer docs (erc-8004.quicknode.com/docs/contracts).
 */
export const REPUTATION_REGISTRY_ABI = [
  // ── Reads ───────────────────────────────────────────────────────────────

  /** Returns the Identity Registry address this Reputation Registry is bound to. */
  {
    type: 'function',
    name: 'getIdentityRegistry',
    inputs: [],
    outputs: [{ name: 'identityRegistry', type: 'address' }],
    stateMutability: 'view',
  },

  /**
   * Read a single feedback entry.
   *
   * feedbackIndex is 1-indexed; 0 is invalid.
   */
  {
    type: 'function',
    name: 'readFeedback',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
      { name: 'feedbackIndex', type: 'uint64' },
    ],
    outputs: [
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'isRevoked', type: 'bool' },
    ],
    stateMutability: 'view',
  },

  /**
   * Aggregated feedback summary filtered by optional tags.
   */
  {
    type: 'function',
    name: 'getSummary',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
    ],
    outputs: [
      { name: 'count', type: 'uint64' },
      { name: 'summaryValue', type: 'int128' },
      { name: 'summaryValueDecimals', type: 'uint8' },
    ],
    stateMutability: 'view',
  },

  /**
   * Read all feedback for an agent, optionally filtered by client addresses
   * and tags. Set `includeRevoked` to also return revoked entries.
   */
  {
    type: 'function',
    name: 'readAllFeedback',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'includeRevoked', type: 'bool' },
    ],
    outputs: [
      { name: 'clients', type: 'address[]' },
      { name: 'feedbackIndexes', type: 'uint64[]' },
      { name: 'values', type: 'int128[]' },
      { name: 'valueDecimals', type: 'uint8[]' },
      { name: 'tag1s', type: 'string[]' },
      { name: 'tag2s', type: 'string[]' },
      { name: 'revokedStatuses', type: 'bool[]' },
    ],
    stateMutability: 'view',
  },

  // ── Writes ──────────────────────────────────────────────────────────────

  /**
   * Submit feedback for an agent. Caller must NOT be the agent's owner or
   * an approved operator for agentId.
   */
  {
    type: 'function',
    name: 'giveFeedback',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'endpoint', type: 'string' },
      { name: 'feedbackURI', type: 'string' },
      { name: 'feedbackHash', type: 'bytes32' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },

  /** Revoke previously given feedback. */
  {
    type: 'function',
    name: 'revokeFeedback',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'feedbackIndex', type: 'uint64' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },

  // ── Events ──────────────────────────────────────────────────────────────

  {
    type: 'event',
    name: 'NewFeedback',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'clientAddress', type: 'address', indexed: true },
      { name: 'feedbackIndex', type: 'uint64', indexed: false },
      { name: 'value', type: 'int128', indexed: false },
      { name: 'valueDecimals', type: 'uint8', indexed: false },
      { name: 'indexedTag1', type: 'string', indexed: true },
      { name: 'tag1', type: 'string', indexed: false },
      { name: 'tag2', type: 'string', indexed: false },
      { name: 'endpoint', type: 'string', indexed: false },
      { name: 'feedbackURI', type: 'string', indexed: false },
      { name: 'feedbackHash', type: 'bytes32', indexed: false },
    ],
  },

  {
    type: 'event',
    name: 'FeedbackRevoked',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'clientAddress', type: 'address', indexed: true },
      { name: 'feedbackIndex', type: 'uint64', indexed: false },
    ],
  },
] as const;
