# ERC-8004 Reputation Registry (P1.7)

Vector anchors per-round agent feedback on the **canonical ERC-8004 Reputation
Registry** on Mantle Sepolia testnet. This document records the VERIFY V2
resolution, the integration surface, the authorization model, and the operator
runbook.

## VERIFY V2 — resolved as fact (on-chain verified)

The canonical ERC-8004 singletons are **already deployed** on Mantle Sepolia
(`chainId 5003`). Vector does **not** deploy its own — it reads/writes the shared
registry.

| Contract             | Address                                      |
| -------------------- | -------------------------------------------- |
| ReputationRegistry   | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| IdentityRegistry     | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |

**Source of truth:** the official monorepo
[`github.com/erc-8004/erc-8004-contracts`](https://github.com/erc-8004/erc-8004-contracts)
(master README + `abis/ReputationRegistry.json`).

**On-chain confirmation** (via `https://rpc.sepolia.mantle.xyz`):

- `eth_getCode` at the reputation address returns non-empty bytecode (UUPS proxy).
- `getIdentityRegistry()` returns the identity address above (cross-check).
- `getVersion()` → `2.0.0`; `UPGRADE_INTERFACE_VERSION` → `5.0.0`.

These addresses live in the P0.1 config single source
(`lib/config/constants.ts` → `CONFIG.chain.{reputation,identity}_registry_address`)
and are validated as checksummed addresses at module load
(`lib/config/constants.schema.ts`). The vendored ABI is at
`lib/chain/abis/ReputationRegistry.json`; a typed subset used by the app is in
`lib/chain/abi.ts`, kept in lock-step by `tests/unit/chain.abi.test.ts`.

## Authorization model (important — differs from the prompt's draft)

The **deployed** `giveFeedback(agentId, value, valueDecimals, tag1, tag2,
endpoint, feedbackURI, feedbackHash)` takes **no off-chain signature argument**.
Authorization is by **`msg.sender`**: the feedback author is whichever address
sent the transaction, and `getClients(agentId)` enumerates those authors. In
Vector's operator model that sender is the funded operator wallet
(`OPERATOR_PRIVATE_KEY`), so on-chain authorization is the **secp256k1
transaction signature** — there is no separate EIP-191/ERC-1271 "FeedbackAuth"
layer in this contract version (that belonged to an earlier ERC-8004 draft).

**Self-feedback is forbidden by the contract.** `giveFeedback` guards with
`require(!isAuthorizedOrOwner(msg.sender, agentId), "Self-feedback not
allowed")`. An agent's owner / operator / approved address therefore **cannot**
attest about its own agent — the feedback author must be a *different* address
than the agent owner. Vector consequently needs **two distinct keys**: an
**owner key** that registers the seed agents in the Identity Registry, and a
separate **attestor key** that calls `giveFeedback`. (This also matches the
honest narrative: the arena/referee is a third-party client attesting about an
agent it does not own — not self-assessment.) Same call also reverts with
`ERC721NonexistentToken` if `agentId` is not a registered token.

EIP-191/ERC-1271 verification still ships in `lib/chain/auth.ts` for
authenticating Vector's **off-chain** feedback payload (served at `feedback_uri`,
integrity-anchored by `feedback_hash`) and to stay forward-compatible. It reuses
viem's `recoverMessageAddress` (offline EOA) and `verifyMessage` (ERC-1271 via a
client), mirroring `lib/intent/verify.ts`, and returns `false` rather than
throwing on malformed input.

## agentId provenance (Identity Registry coupling)

A Reputation Registry `agentId` is the **ERC-721 tokenId in the Identity
Registry** — it cannot be invented. `IdentityRegistry.register(uri)` is a
permissionless self-mint: `msg.sender` becomes the agent's owner and receives a
fresh, auto-incrementing tokenId (`agentId = _lastId++`), emitted as
`Registered(uint256 indexed agentId, string agentURI, address indexed owner)`.

> ⚠️ **Resolved blocker (was a real footgun).** An earlier revision assigned each
> seed agent a 1-based id (`1, 2, 3, …`) from the roster order. On the canonical
> registry those tokenIds are **already owned by an unrelated party**
> (`ownerOf(1)` → `0x3D75…`), so writing feedback against them would attest
> *someone else's* agent and revert the self-feedback guard. That placeholder
> assignment has been **removed**.

The data model is now **null-until-registered** (matches §7.1,
`agents.agent_id_onchain` is "nullable until registered"):

- A seed agent has **no** on-chain id until it is really registered. Its
  `agents.agent_id_onchain` stays `NULL`.
- `lib/chain/identity.ts` `registerAgent(client, identityAddress, agentURI)`
  performs the mint **with the owner key** and returns the minted tokenId,
  decoded from the `Registered` event in the confirmed receipt — never guessed.
  That tokenId is persisted into `agents.agent_id_onchain`.
- On the read/write path, `lib/chain/agent-id.ts` `parseOnchainAgentId(value)`
  validates the stored value into a `uint256`, throwing if `NULL`/malformed so a
  feedback write **fails closed** instead of inventing or reusing an id. The
  non-throwing `tryOnchainAgentId` is for display paths that tolerate
  not-yet-registered agents.
- Before any `giveFeedback`, `assertCanAttest(reader, attestor, agentId)` checks
  on-chain that the agent **exists** and that the attestor is **not** its
  owner/operator — turning both possible reverts (`ERC721NonexistentToken`,
  `Self-feedback not allowed`) into deterministic, typed errors.

### Identity registration runbook (path A — register in the canonical registry)

This is the minimal, reversible path that makes the seed agents writable on the
shared registry, with **no contract deploy**:

1. Configure two distinct keys (see below): `OPERATOR_PRIVATE_KEY` (owner) and
   `ATTESTOR_PRIVATE_KEY` (feedback author). Fund the **operator** address with
   Mantle Sepolia MNT for registration gas.
2. For each seed agent without an `agent_id_onchain`, call `registerAgent(...)`
   with the agent card URI. Persist the returned tokenId into
   `agents.agent_id_onchain` (idempotent: skip agents that already have one).
3. From then on, feedback writes (P1.8) read `agent_id_onchain`, run
   `assertCanAttest` with the **attestor** address, and call `giveFeedback` from
   the attestor wallet.

The contract surface for this lives in the typed `identityRegistryAbi`
(`lib/chain/abi.ts`). Note: the *published* `abis/IdentityRegistry.json` predates
the deployed **v2** contract and is **missing `isAuthorizedOrOwner`**, so it is
**not** vendored; the typed subset is authored from the v2 source and verified
against the **live** contract by the gated integration suite.

## Integration surface

- `lib/chain/network.ts` — pure viem `Chain` for Mantle Sepolia, derived from
  `CONFIG` (secret-free).
- `lib/chain/client.ts` — **server-only**. Lazy singleton public (read) client
  and operator wallet (write) client built from `ENV.MANTLE_TESTNET_RPC_URL` /
  `ENV.OPERATOR_PRIVATE_KEY`. `getReputationReader()` adapts the public client
  into a `ReputationReader`. RPC round-trips are bounded (`RPC_TIMEOUT_MS = 10s`).
- `lib/chain/registry.ts` — the read wrapper (DI on `ReputationReader`):
  `smokeRead`, `getIdentityRegistry`, `getVersion`, `getClients`, `getLastIndex`,
  `getAgentSummary`, `readFeedback`. Validates every untrusted input
  (agentId/uint bounds, address format) **before** the RPC and every response
  shape **after**, surfacing a typed `RegistryError` — never a panic.
- `lib/chain/operator.schema.ts` — pure, value-free signing-key parsing for
  both keys (`parseOperatorKey`, `parseAttestorKey`) plus the
  `assertDistinctSignerKeys` two-key invariant.
- `lib/chain/identity.ts` — Identity Registry access (DI on `IdentityReader` /
  `IdentityWriteClient`): `agentExists`, `assertCanAttest` (the two-key/self-
  feedback guard), and `registerAgent` (mint + decode the minted tokenId).

### Quirk: `getSummary` has no "all clients" sentinel

The canonical `getSummary` **reverts on an empty `clientAddresses` array**
(`"clientAddresses required"`). `getAgentSummary` rejects an empty set
client-side as a `RegistryError` rather than paying for the revert. To aggregate
"every client", first call `getClients(agentId)` and pass the result.

### Smoke-read

```ts
import { getReputationReader } from '@/lib/chain/client';
import { smokeRead } from '@/lib/chain/registry';
import { CONFIG } from '@/lib/config/constants';

const result = await smokeRead(
  getReputationReader(),
  CONFIG.chain.reputation_registry_address as `0x${string}`,
);
// → { address, deployed: true, identityRegistry, version: '2.0.0' }
```

## Signing-key runbook (two keys)

- **Two distinct keys, enforced.** `OPERATOR_PRIVATE_KEY` (owner: registers
  agents) and `ATTESTOR_PRIVATE_KEY` (author: writes feedback) **must** resolve
  to different addresses. `assertDistinctSigners()` (via the pure
  `assertDistinctSignerKeys`) fails closed if they match, because the registry
  rejects feedback from an agent's owner/operator and the operator key owns every
  registered agent — a shared key would make every `giveFeedback` revert.
- **Storage:** both keys live only in server env (`ENV`, `server-only`). They
  never enter the client bundle, never appear in logs or error messages (parser
  rejections are value-free), and are read lazily so a read-only deploy needs no
  key.
- **Funding:** the **operator** address (`getOperatorAddress()`) pays gas for
  `register` (identity registration); the **attestor** address
  (`getAttestorAddress()`) pays gas for `giveFeedback` (P1.8). Fund both via a
  Mantle Sepolia faucet.
- **Nonce/gas:** viem estimates gas and manages the nonce per transaction. Under
  concurrent writes, serialize through a single in-flight operation upstream
  (P1.8) rather than racing the nonce from multiple callers on one key.
- **Rotation:** generate a new key, fund its address, update
  `OPERATOR_PRIVATE_KEY`, redeploy. `resetChainClients()` (test-only) drops cached
  clients; production picks up the new key on next boot. No on-chain
  de-authorization is needed because authorization is per-`msg.sender`.

## Tests

- `tests/unit/chain.*.test.ts` — ABI/drift, registry input+output validation,
  signing keys + two-key distinctness, network def, `parseOnchainAgentId`
  validation, identity reader/`assertCanAttest`/`registerAgent`, EIP-191/ERC-1271
  auth.
- `tests/fuzz/chain.*.fuzz.test.ts` — every untrusted input/response is handled
  or typed-rejected, never an untyped throw (including garbage register receipts
  and arbitrary `agent_id_onchain` strings).
- `tests/integration/chain.integration.test.ts` and
  `tests/e2e/chain.e2e.test.ts` — real Mantle Sepolia, **gated on
  `MANTLE_TESTNET_RPC_URL`**:

  ```sh
  MANTLE_TESTNET_RPC_URL='https://rpc.sepolia.mantle.xyz' \
    bun test tests/integration tests/e2e
  ```
