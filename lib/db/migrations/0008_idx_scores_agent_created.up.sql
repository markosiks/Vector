-- ---------------------------------------------------------------------------
-- 0008 — index for per-agent score history (DB-4)
--
-- `listScoreHistoryByAgent` filters by agent_id and orders by (created_at, id).
-- This composite index serves both the filter and the sort, removing the
-- in-memory sort that grew linearly with an agent's score count.
-- ---------------------------------------------------------------------------
CREATE INDEX idx_scores_agent_created ON scores (agent_id, created_at ASC, id ASC);
