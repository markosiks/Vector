-- Rollback 0007 — drop the operator-actions audit log and its enum.
DROP TABLE IF EXISTS operator_actions;
DROP TYPE IF EXISTS operator_action_kind;
