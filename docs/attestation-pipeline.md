# Attestation Pipeline (P1.8)

On every round settle, Vector writes **exactly one** ERC-8004 `giveFeedback`
attestation per agent, anchoring the agent's `AgentScore` and policy outcome
on-chain (Mantle Sepolia) with an off-chain detail document addressed by its
`feedbackURI` and pinned by `feedbackHash`. Chain latency never blocks the demo
arc: the attestation is mirrored into Postgres optimistically inside the settle
transaction, and the on-chain write + receipt reconciliation run afterwards.

## Data flow

```
settleRound (per-round BEGIN…COMMIT)
  └─ score → recordScore
  └─ hooks.onAttest ──► mirrorAttestation(db, facts)        [in-transaction]
        deriveOutcomeClass · encodeFeedback · buildAttestationDetail
        → INSERT attestations (chain_state='optimistic')  ON CONFLICT DO NOTHING
COMMIT
  └─ (post-commit, async, off the critical path)
       submitAndReconcile
         ├─ submitAttestation   → assertCanAttest → giveFeedback → latch tx_hash
         └─ reconcile           → poll receipt → confirmed | failed | (stay optimistic)
```

`onAttest` is a no-op when unset, so the default replay path (and the read-only
demo) is byte-identical to P1.4 — determinism preserved.

## Modules

| File | Responsibility | Purity |
| --- | --- | --- |
| `lib/attestation/encode.ts` | `AgentScore → int128` (round half-up, clamp `[0,100]`, `valueDecimals=0`); outcome-class derivation; tag binding. | pure |
| `lib/attestation/build.ts` | Canonical-JSON detail document + `keccak256` hash; `verifyDetailHash`. | pure |
| `lib/attestation/submit.ts` | One `giveFeedback` write behind a DI seam; `tx_hash IS NULL` claim; `feedbackURI` builder. | DI |
| `lib/attestation/reconcile.ts` | Optimistic→terminal receipt watcher with bounded exponential backoff. | DI |
| `lib/attestation/pipeline.ts` | `mirrorAttestation` (in-tx) + `submitAndReconcile` (post-commit) composition. | DI |
| `app/api/attestations/[id]/feedback/route.ts` | Serves the stored detail bytes verbatim at `feedbackURI`. | route |

Chain adapters live in `lib/chain/client.ts`: `getFeedbackWriteClient()`
(attestor wallet → `giveFeedback`) and `getReceiptReader()` (public client →
`getTransactionReceipt`, mapping "not found" → `null`, rethrowing transport
errors).

## Encoding contract

- **value** — absolute `AgentScore` rounded half-up to an integer, clamped to
  `[0,100]`. A non-finite score is *rejected* (`AttestationEncodeError`), never
  coerced to a silent `0`.
- **valueDecimals** — `0`.
- **tag1** — `round_id`.
- **tag2** — `outcome_class`, with strict precedence:
  `halt` if `#halt > 0` **or** the scorer floor-crashed (a drain/floor-crash);
  else `violation` if `#hard > 0 ∨ #soft > 0`; else `clean`.

## Detail document & integrity

`buildAttestationDetail` emits a **canonical JSON** string (recursively
sorted keys; arrays preserve order; `bigint` rejected so the bytes never shift
silently) and `feedbackHash = keccak256(bytes(json))`. The **exact bytes** are
stored in `attestations.feedback_detail` and served verbatim at `feedbackURI`
(`Content-Type: application/json`, `Cache-Control: no-store`, `ETag`/
`X-Feedback-Hash`). Because the served bytes *are* the hashed bytes, there is no
build↔serve drift: `verifyDetailHash(servedBytes, feedbackHash)` always holds.

## Idempotency & chain-state machine

`attestations` carries `chain_state ∈ {optimistic, confirmed, failed}` and a
`UNIQUE (agent_id, round_id)`.

- **Exactly one mirror per round** — `insertAttestationOptimistic` uses
  `ON CONFLICT (agent_id, round_id) DO NOTHING`; a re-settle returns the
  existing row (`created=false`), never a duplicate.
- **Single submit winner** — `recordAttestationSubmission` claims the row with
  `UPDATE … WHERE id = $1 AND tx_hash IS NULL`. A replay (row already has a
  `tx_hash`) short-circuits to `already_submitted`; a lost race is reported as
  `raced` — never a second `giveFeedback`.
- **Forward-only reconcile** — `reconcileAttestation` transitions only
  `WHERE chain_state = 'optimistic'`. A confirmation cannot be overwritten by a
  late `failed`.

```
optimistic ──success receipt──► confirmed   (+ block_number, confirmed_at)  [terminal]
optimistic ──revert receipt───► failed                                       [terminal]
optimistic ──pending / RPC flap / budget exhausted──► optimistic  (a later sweep retries)
```

## Fail-closed semantics

- The registry authorizes by `msg.sender`, so attestations require a **separate
  attestor key** (an agent cannot give itself feedback). `assertCanAttest`
  rejects an unregistered agent (`ownerOf → null`) and a self-feedback attestor
  *before* any write.
- A transport flap or a never-mined transaction leaves the row `optimistic`
  (never a false `failed`). Only a genuine on-chain revert is terminal-failed.
- No panics from untrusted input: encode/build reject malformed input with typed
  errors; `verifyDetailHash` returns `false` (never throws) on garbage.

## Configuration

| Env | Use |
| --- | --- |
| `PUBLIC_BASE_URL` | Base for `feedbackURI` (`buildFeedbackUri` enforces `http(s)` at runtime). |
| `MANTLE_TESTNET_RPC_URL` | Public client for the receipt watcher. |
| attestor wallet key (chain client) | Signs `giveFeedback` (distinct from the agent-owner key). |

`ReputationRegistry 0x8004B663056A597Dffe9eCcC1965A193B7388713`,
`IdentityRegistry 0x8004A818BFB912233c491871b3d84c89A494BD9e` (Mantle Sepolia,
chain 5003). See `docs/erc8004-registry.md`.

## Testing

- **Unit** (`tests/unit/attestation.*.test.ts`) — encode/build/submit/reconcile/
  pipeline against in-memory fakes (`tests/fixtures/attestation-db.ts`).
- **Fuzz** (`tests/fuzz/attestation.fuzz.test.ts`) — encode/derive are total over
  finite/valid input and typed-reject otherwise; canonical-JSON is order-invariant;
  `buildAttestationDetail` bytes always re-hash; `verifyDetailHash` never throws.
- **Integration** (`tests/integration/attestation.integration.test.ts`, gated on
  `DATABASE_URL`) — idempotent mirror, single-winner submit latch, forward-only
  reconcile, hash round-trip under the real constraints.
- **E2E** (`tests/e2e/attestation.e2e.test.ts`, gated on `DATABASE_URL`) — full
  mirror → submit → reconcile → served-bytes-verify arc with a scripted chain
  seam, asserting idempotency across a double settle and a reconcile re-run.

## Operational notes & known limits

- Cross-process serialization of the submit claim relies on the DB latch; the
  reconcile loop is in-process and idempotent, so a crashed sweep is safe to
  re-run (a later sweep re-reads and continues).
- The migration is `0006_attestation_feedback_detail` (adds `feedback_detail`).
- A truly live `giveFeedback` requires a registered agent and a funded attestor
  wallet; the e2e exercises the composition with injected chain clients so it
  runs without that out-of-band setup.
