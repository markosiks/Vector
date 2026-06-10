-- Rollback 0008 — drop the per-agent score-history index.
DROP INDEX IF EXISTS idx_scores_agent_created;
