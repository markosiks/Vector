-- ---------------------------------------------------------------------------
-- 0007 — operator_actions audit log (P2.4)
--
-- An append-only audit trail of every accepted operator-console action: who
-- (actor label — the console is a single shared operator identity), when
-- (created_at), and what (kind + a structured detail payload). It records the
-- security-relevant control-plane events — global HALT toggles, per-agent HALT
-- toggles, and scripted-attack injections — so an incident can be reconstructed
-- after the fact. It never stores secrets (no token, no connection string);
-- `detail_json` carries only the action's parameters and its outcome.
--
-- This table is a *log*, not state: the live kill-switch state lives in
-- `kill_switch` and per-agent state in `agents.status`. Rows are immutable.
-- ---------------------------------------------------------------------------

CREATE TYPE operator_action_kind AS ENUM ('kill_switch', 'agent_status', 'attack');

CREATE TABLE operator_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        operator_action_kind NOT NULL,
  -- The operator identity. The console authenticates a single shared operator,
  -- so this is a stable label ('operator') today; kept as text to admit named
  -- operators later without a migration.
  actor       text NOT NULL DEFAULT 'operator',
  -- The agent the action targeted, when applicable (per-agent HALT, attack).
  -- RESTRICT so an audited agent cannot be deleted out from under its log.
  agent_id    uuid REFERENCES agents (id) ON DELETE RESTRICT,
  -- Structured parameters + outcome (reason, status, decision, intent_hash, …).
  detail_json jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The console reads the most recent actions, newest first; the (created_at, id)
-- order is the deterministic tie-break used everywhere else in the read layer.
CREATE INDEX idx_operator_actions_created ON operator_actions (created_at DESC, id DESC);
