# VectorMeritRegistry

**Auxiliary on-chain merit/eligibility cache for Vector on Mantle.**

This contract is a **custom auxiliary registry** that complements the canonical
ERC-8004 registries — it is **NOT itself ERC-8004**. The canonical on-chain
reputation layer is:

- **Identity Registry** (ERC-8004): `0x8004A818BFB912233c491871b3d84c89A494BD9e`
- **Reputation Registry** (ERC-8004): `0x8004B663056A597Dffe9eCcC1965A193B7388713`
  (via `giveFeedback`)

`VectorMeritRegistry` stores a single latest merit score per agent so
routers/firewalls can gate eligibility in one `SLOAD` without querying the
canonical registry on every check.

## Score Model

- **Integer 0..100** (`MAX_SCORE = 100`), matching the ERC-8004 feedback
  `value` at `valueDecimals = 0`.
- The score is attested by an authorized off-chain attestor; the contract
  records the score, an evidence hash, a timestamp, and a strictly-increasing
  nonce per agent.

## API Summary

| Function | Access | Description |
|---|---|---|
| `attestScore(agentId, score, evidenceHash)` | attestor, whenNotPaused | Record a merit score for an agent |
| `latestScore(agentId)` | view | Latest score record (score, evidenceHash, timestamp, nonce, exists) |
| `isEligible(agentId, minScore)` | view | True iff attested AND score >= minScore |
| `proposeAttestor(newAttestor)` | owner | Propose a new attestor (2-step rotation) |
| `acceptAttestor()` | pendingAttestor | Accept the proposed attestor role |
| `pause()` / `unpause()` | owner | Emergency pause/unpause of attestScore |
| `renounceOwnership()` | — | Disabled (always reverts with `RenounceDisabled`) |

## Deploy

```bash
# OWNER_ADDRESS and ATTESTOR_ADDRESS must be DIFFERENT addresses.
OWNER_ADDRESS=0x... \
ATTESTOR_ADDRESS=0x... \
EXPECTED_CHAIN_ID=5003 \
forge script script/Deploy.s.sol:DeployScript \
  --rpc-url https://rpc.sepolia.mantle.xyz \
  --private-key $DEPLOYER_KEY \
  --broadcast --verify
```

## Deployed (Mantle Sepolia, chainId 5003)

| Field | Value |
|---|---|
| **VectorMeritRegistry** | `0x1894Be93D9ACA27b7A6AF0eaD56354D9EbA0Ffb9` |
| Owner | `0x14BA21DDDdC237D73Ae02b6E451a75C5B24bb8C8` |
| Attestor | `0x802DA71f4aBC063edF5F24bC4f32c86C5aE0De02` |
| Scale | integer `0..100` (`valueDecimals = 0`) |

> The previous 0..1000-scale deployment at
> `0x00dd1ee8dc51b8fb704487feba103cf782c6ab12` is **retired** — it predates the
> score-scale alignment and must not be used.

Live round-trip verified on-chain (`attestScore → latestScore → isEligible`):
agentId `1` attested score `74` → `isEligible(1, 50) = true`,
`isEligible(1, 90) = false`.

## Build / Test / Coverage

```bash
forge build
forge test -vvv
forge coverage
```

## License

MIT
