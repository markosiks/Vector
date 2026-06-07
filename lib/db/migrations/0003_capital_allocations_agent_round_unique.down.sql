-- 0003 — rollback: drop the uniqueness/range constraints and restore the index.
--
-- IF EXISTS keeps the rollback idempotent (a partially-applied or re-run
-- rollback is a no-op). Recreate the non-unique index the up-migration dropped
-- so the pre-0003 schema is restored exactly.

ALTER TABLE capital_allocations
  DROP CONSTRAINT IF EXISTS capital_allocations_agent_round_unique,
  DROP CONSTRAINT IF EXISTS capital_allocations_delta_range;

CREATE INDEX IF NOT EXISTS idx_capital_alloc_agent_round
  ON capital_allocations (agent_id, round_id);
