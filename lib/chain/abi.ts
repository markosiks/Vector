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

/**
 * Typed ERC-8004 **Identity Registry** ABI — the subset Vector calls to register
 * seed agents and to gate feedback authorization.
 *
 * Provenance note: unlike the Reputation Registry, the *published*
 * `abis/IdentityRegistry.json` in `erc-8004/erc-8004-contracts` predates the
 * deployed **v2** contract and is **missing `isAuthorizedOrOwner`** (the very
 * function the live `ReputationRegistry.giveFeedback` self-feedback guard
 * calls). Vendoring that stale JSON would be misleading, so this subset is
 * authored directly from the v2 source (`contracts/IdentityRegistryUpgradeable.sol`,
 * `getVersion() == "2.0.0"`) and is verified against the *live* contract by the
 * gated integration suite (`tests/integration/chain.integration.test.ts`) —
 * stronger provenance than a subset check against an out-of-date artifact.
 *
 * Only the calls Vector issues are included (register, ownerOf,
 * isAuthorizedOrOwner, getAgentWallet, plus the `Registered` event used to
 * decode the minted tokenId); the ERC-721 transfer/admin surface is omitted.
 */
export const identityRegistryAbi = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'agentURI', type: 'string', internalType: 'string' }],
    outputs: [{ name: 'agentId', type: 'uint256', internalType: 'uint256' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
  },
  {
    type: 'function',
    name: 'isAuthorizedOrOwner',
    stateMutability: 'view',
    inputs: [
      { name: 'spender', type: 'address', internalType: 'address' },
      { name: 'agentId', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
  },
  {
    type: 'function',
    name: 'getAgentWallet',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
  },
  {
    type: 'function',
    name: 'getVersion',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string', internalType: 'string' }],
  },
  {
    type: 'event',
    name: 'Registered',
    anonymous: false,
    inputs: [
      { name: 'agentId', type: 'uint256', internalType: 'uint256', indexed: true },
      { name: 'agentURI', type: 'string', internalType: 'string', indexed: false },
      { name: 'owner', type: 'address', internalType: 'address', indexed: true },
    ],
  },
] as const;
