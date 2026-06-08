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

EIP-191/ERC-1271 verification still ships in `lib/chain/auth.ts` for
authenticating Vector's **off-chain** feedback payload (served at `feedback_uri`,
integrity-anchored by `feedback_hash`) and to stay forward-compatible. It reuses
viem's `recoverMessageAddress` (offline EOA) and `verifyMessage` (ERC-1271 via a
client), mirroring `lib/intent/verify.ts`, and returns `false` rather than
throwing on malformed input.

## agentId provenance (Identity Registry coupling)

A Reputation Registry `agentId` is the **ERC-721 tokenId in the Identity
Registry**. The operator deterministically assigns each seed agent a stable id
from the frozen roster order (`lib/chain/agent-id.ts`,
`seedOnchainIdAssignments()`), stamped into `agents.agent_id_onchain`.

> ⚠️ A `giveFeedback` write against the **canonical** registry additionally
> requires that `agentId` be a **registered tokenId in the canonical Identity
> Registry**. Registering/minting agents there is ROADMAP and out of P1.7 scope.
> Until that lands, P1.8 must either (a) register these ids in the canonical
> Identity Registry, or (b) run against a Vector-owned registry pair. The
> prompt's "operator assigns agent_id freely" therefore does not by itself make
> an agent writable against the shared registry — this is a P1.8 prerequisite.

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
- `lib/chain/operator.schema.ts` — pure, value-free operator-key parsing.

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

## Operator key runbook

- **Storage:** `OPERATOR_PRIVATE_KEY` lives only in server env (`ENV`,
  `server-only`). It never enters the client bundle, never appears in logs or
  error messages (parser rejections are value-free), and is read lazily so a
  read-only deploy needs no key.
- **Funding:** the operator address (`getOperatorAddress()`) must hold Mantle
  Sepolia MNT to pay gas for `giveFeedback` (P1.8). Fund via a Mantle Sepolia
  faucet.
- **Nonce/gas:** viem estimates gas and manages the nonce per transaction. Under
  concurrent writes, serialize through a single in-flight operation upstream
  (P1.8) rather than racing the nonce from multiple callers on one key.
- **Rotation:** generate a new key, fund its address, update
  `OPERATOR_PRIVATE_KEY`, redeploy. `resetChainClients()` (test-only) drops cached
  clients; production picks up the new key on next boot. No on-chain
  de-authorization is needed because authorization is per-`msg.sender`.

## Tests

- `tests/unit/chain.*.test.ts` — ABI/drift, registry input+output validation,
  operator key, network def, agentId assignment, EIP-191/ERC-1271 auth.
- `tests/fuzz/chain.fuzz.test.ts` — every untrusted input/response is handled or
  typed-rejected, never an untyped throw.
- `tests/integration/chain.integration.test.ts` and
  `tests/e2e/chain.e2e.test.ts` — real Mantle Sepolia, **gated on
  `MANTLE_TESTNET_RPC_URL`**:

  ```sh
  MANTLE_TESTNET_RPC_URL='https://rpc.sepolia.mantle.xyz' \
    bun test tests/integration tests/e2e
  ```
