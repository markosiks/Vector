# ERC-8004 Reputation Registry — P1.7

> **Status:** Implemented  
> **VERIFY V2:** ✅ Resolved — canonical singleton EXISTS on Mantle Sepolia.  
> **Scope:** Read-path + config; write-path is P1.8.

---

## 1. VERIFY V2 Resolution

**Question:** Does a canonical singleton Reputation Registry exist on Mantle Sepolia testnet?

**Answer: YES.** The canonical ERC-8004 registries are deployed on Mantle Sepolia as
CREATE2-deterministic singletons. No custom deployment is needed.

| Registry | Address | Deploy block |
|---|---|---|
| **Identity Registry** | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | ~34,586,935 |
| **Reputation Registry** | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | 34,586,937 |
| **Validation Registry** | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` | ~34,586,940 |

**Chain ID:** 5003 (Mantle Sepolia Testnet)  
**Explorer:** https://explorer.sepolia.mantle.xyz  
**Native currency:** MNT (18 decimals)

**Sources:**
- [ERC-8004 QuickNode Explorer — Contract Addresses](https://erc-8004.quicknode.com/docs/contracts)
- [Official EIP specification](https://eips.ethereum.org/EIPS/eip-8004)
- [Reference contracts repo](https://github.com/erc-8004/erc-8004-contracts)
- [Awesome ERC-8004 — deployment table](https://github.com/sudeepb02/awesome-erc8004)

### CREATE2 Determinism

All testnet chains share the same pair of addresses (`0x8004A818...` for Identity,
`0x8004B663...` for Reputation). Mainnet chains share a different pair (`0x8004A169...`
for Identity, `0x8004BAa1...` for Reputation). The `0x8004` vanity prefix is part of the
CREATE2 salt strategy used by the ERC-8004 team.

---

## 2. Architecture

```
lib/chain/
├── index.ts                  # Barrel re-export (public surface)
├── addresses.ts              # Canonical addresses + deploy block
├── mantle-sepolia.ts         # viem Chain definition
├── client.ts                 # Lazy singleton viem clients (server-only)
├── reputation-read.ts        # Read helpers: smokeRead, readFeedback, getSummary
├── feedback-auth.ts          # EIP-191 feedback authorization signing/verifying
├── agent-id.ts               # Deterministic agent_id_onchain derivation
└── abi/
    └── reputation-registry.ts # Minimal ABI subset used by Vector
```

**Single source of truth:** Registry addresses and deploy block live in
`lib/config/constants.ts` → `CONFIG.erc8004.*`, validated by
`constants.schema.ts` → `erc8004Schema`.

**Environment variables** (in `lib/config/env.ts`):
| Variable | Required | Purpose |
|---|---|---|
| `MANTLE_TESTNET_RPC_URL` | For chain reads | RPC endpoint for Mantle Sepolia |
| `OPERATOR_PRIVATE_KEY` | For writes (P1.8) | Operator EOA key — **server-only** |

---

## 3. Feedback Authorization Model

### Background

The ERC-8004 Reputation Registry allows any address to call `giveFeedback(agentId, ...)`,
subject to one constraint: **the caller must NOT be the agent's owner or an approved
operator for that `agentId`**.

To prevent spam, the spec recommends that the **server agent** (the one receiving
feedback) issue a signed **feedback authorization** to the client before the client
submits. The signature can be verified via:

- **EIP-191** (`personal_sign`): for EOA signers.
- **ERC-1271** (`isValidSignature`): for smart-contract wallets.

### Vector's [CORE] Model

Vector's operator is a server-side EOA (`OPERATOR_PRIVATE_KEY`), so **EIP-191 is the
primary path**. The authorization flow:

1. Operator derives a deterministic `agentId` for each seed agent (see §4).
2. When authorizing feedback, operator signs:
   ```
   digest = keccak256(abi.encodePacked(agentId, clientAddress, maxFeedbackIndex, expiry))
   ```
3. The signed message uses EIP-191 `personal_sign` wrapping.
4. The client (which may also be the operator, from a different address) submits
   `giveFeedback` and attaches the authorization signature off-chain (or on-chain
   if the registry version requires it).

### Implementation

```typescript
import { signFeedbackAuth, verifyFeedbackAuth, isAuthExpired } from '@/lib/chain/feedback-auth';

// Sign
const auth = await signFeedbackAuth(operatorKey, {
  agentId: 42n,
  clientAddress: '0x...',
  maxFeedbackIndex: 100n,
  expiry: BigInt(Math.floor(Date.now() / 1000) + 3600), // 1 hour
});

// Verify
const valid = await verifyFeedbackAuth(auth, operatorAddress);
```

---

## 4. `agent_id_onchain` Provenance

Since the Identity Registry and Identity-NFT are **[ROADMAP]** (out of scope for
[CORE]), there is no canonical ERC-721 `tokenId` for each agent yet.

Vector's operator **assigns** each seed agent a deterministic `agent_id_onchain`:

```
agent_id_onchain = uint256(keccak256(abi.encodePacked(
    "vector-agent-v1",    // namespace prefix
    operatorAddress,       // prevents cross-operator collisions
    agentStableId         // e.g. "seed-leader"
)))
```

This ID:
- Is stored in `agents.agent_id_onchain` (existing nullable text column).
- Is used as the `agentId` parameter in `giveFeedback` calls (P1.8).
- Will be replaced by the real ERC-721 `tokenId` when the Identity Registry is adopted.

```typescript
import { deriveAgentIdOnchain, formatAgentIdOnchain } from '@/lib/chain/agent-id';

const id = deriveAgentIdOnchain('seed-leader', operatorAddress);
const hex = formatAgentIdOnchain(id); // "0x..." (64 hex chars)
```

---

## 5. Smoke Read

The simplest health check is reading `getIdentityRegistry()` from the Reputation
Registry. If it returns the expected address, the registry is live and reachable.

```typescript
import { getPublicClient } from '@/lib/chain/client';
import { smokeRead } from '@/lib/chain/reputation-read';

const result = await smokeRead(getPublicClient());
if (result.ok) {
  console.log('Registry live:', result.identityRegistry);
} else {
  console.error('Registry unreachable:', result.error);
}
```

---

## 6. Operator Key Runbook

### Key Provisioning

1. Generate a new EOA key: `cast wallet new` (or any standard tool).
2. Set `OPERATOR_PRIVATE_KEY=0x...` in the server environment (`.env.local`, CI secrets,
   Vercel env vars). **Never** commit to source control.
3. Fund the operator address with testnet MNT (Mantle Sepolia faucet).

### Key Rotation

1. Generate a new key.
2. Update `OPERATOR_PRIVATE_KEY` in all server environments.
3. Re-derive `agent_id_onchain` values (they include the operator address).
4. Update `agents.agent_id_onchain` rows in the database.
5. Ensure the new address is funded.

### Key Safety Invariants

- The key is loaded via `ENV.OPERATOR_PRIVATE_KEY` (validated by `env.schema.ts`).
- The `client.ts` module imports `server-only`, preventing bundle inclusion.
- Error messages from `smokeRead` and other helpers are scrubbed — they never
  include the key or any 64-hex-char pattern.

---

## 7. ABI Reference

The ABI in `lib/chain/abi/reputation-registry.ts` is a **minimal subset** of the
full Reputation Registry ABI, containing only functions/events Vector uses:

| Type | Name | Purpose |
|---|---|---|
| view | `getIdentityRegistry()` | Smoke-read; returns bound Identity Registry |
| view | `readFeedback(agentId, clientAddress, feedbackIndex)` | Read single entry |
| view | `readAllFeedback(agentId, clientAddresses, tag1, tag2, includeRevoked)` | Bulk read |
| view | `getSummary(agentId, clientAddresses, tag1, tag2)` | Aggregated summary |
| write | `giveFeedback(agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)` | Submit feedback (P1.8) |
| write | `revokeFeedback(agentId, feedbackIndex)` | Revoke feedback |
| event | `NewFeedback` | Emitted on feedback submission |
| event | `FeedbackRevoked` | Emitted on revocation |

Full ABI is at `github.com/erc-8004/erc-8004-contracts/abis/`.

---

## 8. Config Entries

Added to `lib/config/constants.ts` → `CONFIG.erc8004`:

```typescript
erc8004: {
  reputation_registry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  identity_registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  reputation_deploy_block: 34_586_937,
}
```

Validated by `erc8004Schema` in `constants.schema.ts`:
- Addresses: `0x`-prefixed, exactly 40 hex chars.
- Deploy block: positive integer.

---

## 9. Test Coverage Summary

| Layer | Files | Focus |
|---|---|---|
| **Unit** | `tests/unit/chain.*.test.ts` | ABI shape, addresses, config schema, agent-id derivation, feedback-auth sign/verify, reputation-read mocks (≥90% coverage) |
| **Integration** | `tests/integration/chain.registry.integration.test.ts` | Live Mantle Sepolia smoke-read, chain-id, block number (skipped without `MANTLE_TESTNET_RPC_URL`) |
| **Fuzz** | `tests/fuzz/chain.*.fuzz.test.ts` | Randomized inputs for auth digest, sign/verify round-trips, agent-id collisions, adversarial RPC responses |
| **E2E** | `tests/e2e/chain.registry.e2e.test.ts` | RPC timeouts/rate-limits, ABI mismatch, auth signature extremes, key rotation, no-key-leakage |
