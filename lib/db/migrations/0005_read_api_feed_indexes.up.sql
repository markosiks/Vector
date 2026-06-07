-- 0005 — Index the P1.5 read-API feed queries that shipped without backing indexes.
--
-- The P1.5 read API exposed three unauthenticated feeds whose ordering/filter
-- columns were never indexed, so each request degrades to a scan-and-sort that
-- grows superlinearly with table size — and the agent-detail route fans out
-- four such reads per request, so the cost is multiplied. Every other feed query
-- in the repos is explicitly index-served (the doc comments name the index);
-- these two were missed. The fix is purely additive (plus one superseded-index
-- swap) and reversible.
--
--   1. `policy_events`  — `listRecentPolicyEventsByAgent`:
--        WHERE agent_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2
--      had no `agent_id` index (only `(created_at)` and `(round_id, created_at)`),
--      so the agent-detail red-alert feed scanned `(created_at)` and filtered
--      `agent_id` row by row until it accumulated LIMIT matches — pathological for
--      an agent with few events in a large ledger. The composite anchors the
--      equality on `agent_id` and serves the exact keyset order with no sort.
--      It also covers `listPolicyEventsByAgentRound`'s `agent_id` filter via its
--      leftmost prefix.
--
--   2. `attestations` — `listAttestationsPage` (unfiltered):
--        ORDER BY created_at DESC, id DESC LIMIT $n
--      had no `created_at` index at all, forcing a full sort per page (and per
--      keyset seek). `(created_at DESC, id DESC)` serves the order and the
--      `id` tie-break directly.
--
--   3. `attestations` — `listAttestationsPage` (chain_state filter) and
--      `listAttestationsByChainState`:
--        WHERE chain_state = $1 ORDER BY created_at DESC, id DESC ...
--      `chain_state` has only three distinct values, so the single-column
--      `idx_attestations_chain_state` is weakly selective and still leaves the
--      sort unserved. `(chain_state, created_at DESC, id DESC)` filters and orders
--      in one index and strictly supersedes the single-column index for every
--      query that used it (a leftmost-prefix lookup on `chain_state`; the
--      ASC-ordered reconcile read is served by a backward index scan), so the
--      redundant index is dropped — mirroring 0003.

CREATE INDEX idx_policy_events_agent_created
  ON policy_events (agent_id, created_at DESC, id DESC);

CREATE INDEX idx_attestations_created
  ON attestations (created_at DESC, id DESC);

CREATE INDEX idx_attestations_chain_state_created
  ON attestations (chain_state, created_at DESC, id DESC);

DROP INDEX IF EXISTS idx_attestations_chain_state;
