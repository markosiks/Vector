# The Intent Contract (P0.3)

> Vector's single trust boundary. Implements architecture.txt §8.

An autonomous agent in Vector earns the right to move capital, but it never holds
the keys to do so. The **Intent** is the only thing that crosses from the agent's
world (untrusted reasoning, possibly prompt-injected) into Vector's world
(execution against real markets). This document is the normative reference for
that contract: its shape, how it is canonicalized, how it is signed, and the
exact order in which the referee validates it.

If it isn't a typed, signed Intent, it does not cross the boundary. That single
rule is why prompt injection cannot drain the system (boundary **B1**, §5.3):
free-form model output is never executed — only a structurally valid, authentic
Intent is.

---

## 1. Where P0.3 sits

```
 agent.decide(context) ──▶ UnsignedIntent ──▶ harness signs ──▶ Intent ──▶ validateIntent ──▶ referee policy
        (untrusted)          (proposal)        (lib/intent/sign)   (signed)   (lib/intent/validate)   (P1.1)
                                                                              └────────── P0.3 ends here ──────────┘
```

P0.3 owns **authenticity and well-formedness**. It answers: *is this a
syntactically valid Intent, genuinely signed by the agent it claims, fresh, and
within absolute sanity bounds?* It deliberately does **not** answer *should we
allow it?* — market whitelisting, per-agent trade caps, fresh-wallet/drain
detection, and budget enforcement are **referee policy (P1.1)**, layered on top.

## 2. Intent shape (§8.2)

An Intent is a discriminated union on `action`. All fields are strings on the
wire (see §4 on numerics). The schema is `lib/intent/schema.ts`; the JSON Schema
is exported via `intentJsonSchema` / `unsignedIntentJsonSchema` for external
conformance.

| field            | open | modify | close | transfer | notes                                    |
| ---------------- | :--: | :----: | :---: | :------: | ---------------------------------------- |
| `action`         |  ✓   |   ✓    |   ✓   |    ✓     | the discriminant                         |
| `agent_id`       |  ✓   |   ✓    |   ✓   |    ✓     | the claimed issuer                       |
| `nonce`          |  ✓   |   ✓    |   ✓   |    ✓     | unique per `(agent_id, nonce)`           |
| `ttl`            |  ✓   |   ✓    |   ✓   |    ✓     | ISO-8601 UTC expiry                      |
| `size`           |  ✓   |   ✓    |   ✓   |    ✓     | canonical decimal string                 |
| `market`         |  ✓   |   ✓    |   ✓   |          | symbol, e.g. `BTC-PERP`                  |
| `side`           |  ✓   |   ✓    |       |          | `long` \| `short`                        |
| `leverage`       |  ✓   |   ✓    |       |          | canonical decimal string                 |
| `max_slippage`   |  ✓   |   ✓    |   ✓   |          | fraction in `[0, 1]`                     |
| `tp` / `sl`      |  ?   |   ?    |       |          | optional take-profit / stop-loss         |
| `target_address` |      |        |       |    ?     | **only** valid on `transfer`             |
| `signature`      |  ✓   |   ✓    |   ✓   |    ✓     | EIP-191 sig over the canonical payload    |

The schema is `.strict()`: unknown keys are rejected. Types are derived from the
schema with `z.infer` / `z.input` (single source of truth) so the runtime
contract and the TypeScript types can never drift.

### Conditional obligation

`target_address` is the load-bearing conditional: it is **structurally permitted
on every action** by the schema but **only legal on `transfer`**, enforced as the
last validation step (§6f) and backstopped by a DB `CHECK` (P0.2). This is
intentional: keeping it a distinct, observable validation step (rather than a
schema rejection) makes the failure reason explicit and auditable, and prevents a
malformed-but-injected `target_address` from being silently dropped.

## 3. Canonicalization (`lib/intent/canonical.ts`)

A signature is only meaningful if both signer and verifier agree, byte-for-byte,
on *what was signed*. The canonical payload is the deterministic serialization of
all **present** Intent fields **except `signature`**:

- keys sorted lexicographically at every depth (`stableStringify`);
- absent optional fields are **omitted**, never serialized as `null`;
- all numerics normalized to a single canonical decimal string (§4);
- `ttl` normalized to ISO-8601 UTC (`...000Z`);
- `nonce` normalized to its string token.

`intent_hash = keccak256(utf8(canonical_payload))`, a `0x`-prefixed 32-byte hex
string. The hash is stored in the `intents` table and is the stable external
identifier of an Intent.

## 4. Numerics: string end-to-end

Floating point cannot represent prices and sizes exactly, so the contract is
**numeric-as-string end-to-end**. On input a field may be a JS `number` *or* a
string; it is immediately normalized to a canonical decimal string:

```
1   →  "1"      1.0     →  "1"      "1.500" →  "1.5"
.5  →  "0.5"    "1e3"   →  "1000"   "-0.0"  →  "0"
```

Consequence: `size: 1`, `size: 1.0`, and `size: "1.000"` produce an **identical
canonical payload, hash, and signature**. `NaN`, `Infinity`, and non-decimal
strings are rejected at the schema layer. There is a precision cap on literal
length to bound work and reject absurd inputs without panicking.

## 5. Signing convention (`sign.ts` / `verify.ts`)

Signing uses **EIP-191 `personal_sign`** (`viem`'s `signMessage`) over the UTF-8
canonical payload:

```ts
const intent = await signIntent(unsignedInput, privateKey); // adds `signature`
const signer = await recoverIntentSigner(intent);           // EIP-191 recovery
const ok = await verifyIntentSignature(intent, expected);   // checksum-insensitive
```

- The agent holds no key and cannot sign; the harness signs on behalf of the
  agent's registered address. The agent can only *propose* an `UnsignedIntent`.
- Recovery/verification never throws on a malformed signature or address — they
  return `false` (a failed auth is a deterministic *reject*, not an exception).
- **ERC-1271 (smart-contract signers)** is intentionally **out of scope for
  P0.3**: seed agents use EOAs. When contract-account agents are introduced,
  `verifyIntentSignature` is the single seam to extend (EOA `ecrecover` →
  `isValidSignature` fallback); nothing else in the pipeline changes.

## 6. Validation order (§8, normative)

`validateIntent(input, opts)` runs these checks **in order and stops at the first
failure**, returning `{ ok: false, stage, code, message }`. Order matters: a
cheaper/more fundamental failure must mask a later one so the reported reason is
stable and an attacker can't probe later checks by satisfying earlier ones.

| # | stage            | rejects when…                                        | example code              |
| - | ---------------- | ---------------------------------------------------- | ------------------------- |
| a | `schema`         | shape/type invalid, unknown key, bad numeric         | `invalid_schema`          |
| b | `signature`      | signer unauthorized, or signature ≠ canonical payload | `unknown_signer`, `bad_signature` |
| c | `nonce`          | `(agent_id, nonce)` already seen (replay)            | `replayed_nonce`          |
| d | `ttl`            | expired (with optional clock-skew / max-horizon)     | `expired`, `ttl_too_far`  |
| e | `bounds`         | size/leverage ≤ 0, slippage ∉ [0,1], tp/sl ≤ 0       | `nonpositive_size`, …     |
| f | `target_address` | present on a non-`transfer` action                   | `target_only_on_transfer` |

On success it returns `{ ok: true, intent, intent_hash }`.

Notes on the seams the caller wires in:

- **Nonce (c)** is checked via an injected `isNonceUsed(agentId, nonce)`. The
  validator is *pure*; it cannot by itself prevent a concurrent double-spend.
  Single-admission under a replay storm is enforced by an **atomic reserve** —
  `createNonceGuard()` in-process, or a unique constraint / `INSERT … ON
  CONFLICT` on `(agent_id, nonce)` in the DB. `reserve` wins exactly once.
- **TTL (d)** defaults to *no* future horizon and *no* skew; both are opt-in
  (`maxTtlHorizonMs`, `clockSkewMs`). `now === ttl` is still valid (expiry is
  exclusive of the boundary by `<` comparison after skew).
- **Signer authority (b)** is resolved by an injected `resolveSigner(agentId)`
  returning the agent's authorized address (or `null` → `unknown_signer`).

## 7. What P0.3 is **not**

These belong to the referee (P1.1) and later phases, *not* this boundary:

- market whitelist, per-trade and per-round size caps, leverage caps;
- fresh-wallet / drain heuristics on `transfer` targets (a signed transfer to any
  address is structurally valid here — see the e2e tests);
- budget/allocation enforcement;
- ordering/fairness across agents within a round.

A signed `transfer` to `0x…dead` **passes** P0.3. That is correct: P0.3 proves it
is well-formed and authentic; the referee decides it is not *allowed*.

## 8. Reference example

See [`docs/examples/signed-intent.json`](./examples/signed-intent.json) — a
pinned, byte-stable signed Intent (signer = Anvil account #0) with its canonical
payload and `intent_hash`. It is asserted by `tests/unit/intent.golden.test.ts`,
so any change to canonicalization, hashing, or the signing convention fails CI
loudly. Use it as the conformance vector for any independent emitter/verifier.
