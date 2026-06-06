-- 0002 — rollback: drop the durable anti-replay constraint.
--
-- IF EXISTS keeps the rollback idempotent (a partially-applied or re-run
-- rollback is a no-op). Dropping the constraint also drops its backing index.

ALTER TABLE intents
  DROP CONSTRAINT IF EXISTS intents_agent_nonce_unique;
