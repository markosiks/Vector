-- 0005 — rollback: drop the read-API feed indexes and restore the pre-0005 set.
--
-- IF EXISTS keeps the rollback idempotent (a partially-applied or re-run
-- rollback is a no-op). Recreate the single-column `idx_attestations_chain_state`
-- the up-migration dropped so the pre-0005 schema is restored exactly.

CREATE INDEX IF NOT EXISTS idx_attestations_chain_state
  ON attestations (chain_state);

DROP INDEX IF EXISTS idx_attestations_chain_state_created;
DROP INDEX IF EXISTS idx_attestations_created;
DROP INDEX IF EXISTS idx_policy_events_agent_created;
