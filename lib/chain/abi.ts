/**
 * Typed ERC-8004 Reputation Registry ABI — the subset Vector actually calls.
 *
 * The full canonical build artifact is vendored verbatim at
 * `lib/chain/abis/ReputationRegistry.json` (source:
 * github.com/erc-8004/erc-8004-contracts, `abis/ReputationRegistry.json`). That
 * JSON is the provenance record; this `as const` array is the *typed* surface
 * viem needs to infer argument and return types at the call sites. A unit test
 * (`tests/unit/chain.abi.test.ts`) asserts every entry here is a byte-faithful
 * subset of the vendored JSON, so the two can never drift.
 *
 * Only read paths and the single write Vector issues (`giveFeedback`, P1.8) are
 * included; the registry's admin/upgrade surface is intentionally omitted —
 * Vector never calls it, and a narrower ABI is a smaller attack surface.
 */
export const reputationRegistryAbi = [
  {
    type: 'function',
    name: 'getIdentityRegistry',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
  },
  {
    type: 'function',
    name: 'getVersion',
    stateMutability: 'pure',
    inputs: [],
    outputs: [{ name: '', type: 'string', internalType: 'string' }],
  },
  {
    type: 'function',
    name: 'getClients',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: '', type: 'address[]', internalType: 'address[]' }],
  },
  {
    type: 'function',
    name: 'getLastIndex',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256', internalType: 'uint256' },
      { name: 'clientAddress', type: 'address', internalType: 'address' },
    ],
    outputs: [{ name: '', type: 'uint64', internalType: 'uint64' }],
  },
  {
    type: 'function',
    name: 'getSummary',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256', internalType: 'uint256' },
      { name: 'clientAddresses', type: 'address[]', internalType: 'address[]' },
      { name: 'tag1', type: 'string', internalType: 'string' },
      { name: 'tag2', type: 'string', internalType: 'string' },
    ],
    outputs: [
      { name: 'count', type: 'uint64', internalType: 'uint64' },
      { name: 'summaryValue', type: 'int128', internalType: 'int128' },
      { name: 'summaryValueDecimals', type: 'uint8', internalType: 'uint8' },
    ],
  },
  {
    type: 'function',
    name: 'readFeedback',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256', internalType: 'uint256' },
      { name: 'clientAddress', type: 'address', internalType: 'address' },
      { name: 'feedbackIndex', type: 'uint64', internalType: 'uint64' },
    ],
    outputs: [
      { name: 'value', type: 'int128', internalType: 'int128' },
      { name: 'valueDecimals', type: 'uint8', internalType: 'uint8' },
      { name: 'tag1', type: 'string', internalType: 'string' },
      { name: 'tag2', type: 'string', internalType: 'string' },
      { name: 'isRevoked', type: 'bool', internalType: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'giveFeedback',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256', internalType: 'uint256' },
      { name: 'value', type: 'int128', internalType: 'int128' },
      { name: 'valueDecimals', type: 'uint8', internalType: 'uint8' },
      { name: 'tag1', type: 'string', internalType: 'string' },
      { name: 'tag2', type: 'string', internalType: 'string' },
      { name: 'endpoint', type: 'string', internalType: 'string' },
      { name: 'feedbackURI', type: 'string', internalType: 'string' },
      { name: 'feedbackHash', type: 'bytes32', internalType: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'NewFeedback',
    anonymous: false,
    inputs: [
      { name: 'agentId', type: 'uint256', internalType: 'uint256', indexed: true },
      { name: 'clientAddress', type: 'address', internalType: 'address', indexed: true },
      { name: 'feedbackIndex', type: 'uint64', internalType: 'uint64', indexed: false },
      { name: 'value', type: 'int128', internalType: 'int128', indexed: false },
      { name: 'valueDecimals', type: 'uint8', internalType: 'uint8', indexed: false },
      { name: 'indexedTag1', type: 'string', internalType: 'string', indexed: true },
      { name: 'tag1', type: 'string', internalType: 'string', indexed: false },
      { name: 'tag2', type: 'string', internalType: 'string', indexed: false },
      { name: 'endpoint', type: 'string', internalType: 'string', indexed: false },
      { name: 'feedbackURI', type: 'string', internalType: 'string', indexed: false },
      { name: 'feedbackHash', type: 'bytes32', internalType: 'bytes32', indexed: false },
    ],
  },
] as const;
