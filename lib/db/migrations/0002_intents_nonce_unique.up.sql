-- 0002 — Durable anti-replay for Intents.
--
-- §6.3 / §10 require a replayed (agent_id, nonce) Intent to be rejected, and the
-- §8.2 `nonce` field exists for exactly that. P0.3 enforced it only with an
-- in-memory guard (createNonceGuard): lost on process restart and not shared
-- across instances, so the durable guarantee the validator's contract promises
-- did not actually exist.
--
-- Anchor it at the source of truth: a UNIQUE (agent_id, nonce) constraint makes a
-- duplicate Intent insert fail atomically in a single statement, independent of
-- any process-local state. The reserve path uses
-- INSERT ... ON CONFLICT (agent_id, nonce) DO NOTHING against this constraint
-- (lib/db/repos/intents.ts:insertIntentReserving).
--
-- NULL nonces are exempt by design: Postgres treats NULLs as distinct, so the
-- smoke-seed row and any non-replay-scoped internal row never collide. Every
-- real, agent-authored Intent carries a non-null nonce (enforced by the Intent
-- schema), so anti-replay applies to exactly the rows that need it.

ALTER TABLE intents
  ADD CONSTRAINT intents_agent_nonce_unique UNIQUE (agent_id, nonce);
