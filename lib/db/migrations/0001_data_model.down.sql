-- 0001 — Vector data model. Rollback migration.
--
-- Drops everything 0001 created, in reverse dependency order. Tables go first
-- (CASCADE removes their indexes/constraints), then the enum types, then the
-- extension is intentionally left in place (other migrations may rely on it and
-- dropping a shared extension is destructive beyond this migration's scope).

DROP TABLE IF EXISTS kill_switch          CASCADE;
DROP TABLE IF EXISTS attestations         CASCADE;
DROP TABLE IF EXISTS capital_allocations  CASCADE;
DROP TABLE IF EXISTS scores               CASCADE;
DROP TABLE IF EXISTS outcomes             CASCADE;
DROP TABLE IF EXISTS executions           CASCADE;
DROP TABLE IF EXISTS policy_events        CASCADE;
DROP TABLE IF EXISTS intents              CASCADE;
DROP TABLE IF EXISTS rounds               CASCADE;
DROP TABLE IF EXISTS agents               CASCADE;

DROP TYPE IF EXISTS chain_state;
DROP TYPE IF EXISTS allocation_trigger;
DROP TYPE IF EXISTS execution_status;
DROP TYPE IF EXISTS execution_rail;
DROP TYPE IF EXISTS policy_severity;
DROP TYPE IF EXISTS policy_decision;
DROP TYPE IF EXISTS intent_side;
DROP TYPE IF EXISTS intent_action;
DROP TYPE IF EXISTS round_state;
DROP TYPE IF EXISTS strategy_kind;
DROP TYPE IF EXISTS agent_status;
