-- 0001 — Vector data model (§7.1). Forward migration.
--
-- Source-of-truth rule (§7): Neon is truth for speed/UI; the ERC-8004 write is
-- truth for trust. On-chain fields are mirrored here with a `chain_state` and
-- `tx_hash`. All money/score/CaR columns are `numeric` (never float); all time
-- columns are `timestamptz`. FKs are RESTRICT so a parent with children cannot
-- be deleted (no dangling references).

-- UUID generator (pgcrypto-provided in Neon/PG13+).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Enum domains. Named separately on purpose: a single "status" hides two
-- distinct domains (agents vs executions); the data model keeps them apart.
-- ---------------------------------------------------------------------------
CREATE TYPE agent_status      AS ENUM ('active', 'halted', 'gated');                 -- operator / router gate
CREATE TYPE strategy_kind     AS ENUM ('seed', 'external');
CREATE TYPE round_state       AS ENUM ('open', 'settling', 'settled');
CREATE TYPE intent_action     AS ENUM ('open', 'close', 'modify', 'transfer');       -- §8.2; `withdraw` is a synonym of `transfer`, no separate value
CREATE TYPE intent_side       AS ENUM ('long', 'short');
CREATE TYPE policy_decision   AS ENUM ('ALLOW', 'CLIP', 'REJECT', 'HALT');
CREATE TYPE policy_severity   AS ENUM ('none', 'soft', 'hard', 'halt');
CREATE TYPE execution_rail    AS ENUM ('byreal');
CREATE TYPE execution_status  AS ENUM ('sent', 'filled', 'partial', 'error');        -- distinct from agent_status
CREATE TYPE allocation_trigger AS ENUM ('settle', 'attestation', 'crash', 'operator'); -- §6.2: 4 re-route triggers
CREATE TYPE chain_state       AS ENUM ('optimistic', 'confirmed', 'failed');

-- ---------------------------------------------------------------------------
-- agents
-- ---------------------------------------------------------------------------
CREATE TABLE agents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id_onchain  text UNIQUE,                          -- ERC-8004 agentId, assigned by operator on register; nullable until then
  display_name      text NOT NULL,
  owner             text NOT NULL,                        -- team / operator
  strategy_kind     strategy_kind NOT NULL,
  status            agent_status NOT NULL DEFAULT 'active',
  score_current     numeric(6, 3) NOT NULL DEFAULT 0      -- denormalized cache of latest score_r ∈ [0,100]
                      CHECK (score_current >= 0 AND score_current <= 100),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- rounds
-- ---------------------------------------------------------------------------
CREATE TABLE rounds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  index       integer NOT NULL UNIQUE CHECK (index >= 0),
  state       round_state NOT NULL DEFAULT 'open',
  seed_ref    text,                                       -- which seed slice
  started_at  timestamptz NOT NULL DEFAULT now(),
  settled_at  timestamptz
);

-- ---------------------------------------------------------------------------
-- intents
-- ---------------------------------------------------------------------------
CREATE TABLE intents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id        uuid NOT NULL REFERENCES rounds(id)  ON UPDATE CASCADE ON DELETE RESTRICT,
  agent_id        uuid NOT NULL REFERENCES agents(id)  ON UPDATE CASCADE ON DELETE RESTRICT,
  intent_hash     text NOT NULL,
  action          intent_action NOT NULL,
  market          text,
  side            intent_side,                            -- only for open/modify
  size            numeric(38, 18) CHECK (size IS NULL OR size >= 0),
  leverage        numeric(12, 6)  CHECK (leverage IS NULL OR leverage >= 0),
  tp              numeric(38, 18),
  sl              numeric(38, 18),
  max_slippage    numeric(12, 6)  CHECK (max_slippage IS NULL OR max_slippage >= 0),
  target_address  text,                                   -- first-class (referee rule #3 reads it typed, not from raw_json)
  nonce           text,
  ttl             timestamptz,
  signature       text,
  raw_json        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- target_address is allowed only on a transfer (§8.2). It is not forced to be
  -- present, so the referee can still reject a malformed transfer.
  CONSTRAINT intents_target_only_on_transfer
    CHECK (target_address IS NULL OR action = 'transfer')
);

-- ---------------------------------------------------------------------------
-- policy_events  (drives the red-alert UI + scoring penalties)
-- ---------------------------------------------------------------------------
CREATE TABLE policy_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id    uuid NOT NULL REFERENCES intents(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  agent_id     uuid NOT NULL REFERENCES agents(id)  ON UPDATE CASCADE ON DELETE RESTRICT,
  round_id     uuid NOT NULL REFERENCES rounds(id)  ON UPDATE CASCADE ON DELETE RESTRICT,
  rule_fired   text NOT NULL,
  decision     policy_decision NOT NULL,
  severity     policy_severity NOT NULL,
  detail_json  jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- executions
-- ---------------------------------------------------------------------------
CREATE TABLE executions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id      uuid NOT NULL REFERENCES intents(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  rail           execution_rail NOT NULL DEFAULT 'byreal',
  rail_order_id  text,
  status         execution_status NOT NULL,
  request_json   jsonb,
  response_json  jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- outcomes
-- execution_id is NULLable: the seeded demo arc (rail=seed, §6.5) can record an
-- outcome with no real execution row.
-- ---------------------------------------------------------------------------
CREATE TABLE outcomes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id    uuid REFERENCES executions(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  agent_id        uuid NOT NULL REFERENCES agents(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  round_id        uuid NOT NULL REFERENCES rounds(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  pnl_realized    numeric(38, 18) NOT NULL DEFAULT 0,
  pnl_marked      numeric(38, 18) NOT NULL DEFAULT 0,
  capital_at_risk numeric(38, 18) NOT NULL DEFAULT 0 CHECK (capital_at_risk >= 0),
  fees            numeric(38, 18) NOT NULL DEFAULT 0 CHECK (fees >= 0),
  position_delta  numeric(38, 18) NOT NULL DEFAULT 0,
  drawdown        numeric(38, 18) NOT NULL DEFAULT 0 CHECK (drawdown >= 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- scores  (raw_r unbounded; score_r is the normalized AgentScore ∈ [0,100])
-- ---------------------------------------------------------------------------
CREATE TABLE scores (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         uuid NOT NULL REFERENCES agents(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  round_id         uuid NOT NULL REFERENCES rounds(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  raw_r            numeric(20, 8) NOT NULL,
  score_r          numeric(6, 3) NOT NULL CHECK (score_r >= 0 AND score_r <= 100),
  components_json  jsonb,                                  -- perf/w/policy/dd breakdown for explainability
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, round_id)
);

-- ---------------------------------------------------------------------------
-- capital_allocations  (labeled testnet units; conserved pool, never minted)
-- ---------------------------------------------------------------------------
CREATE TABLE capital_allocations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       uuid NOT NULL REFERENCES agents(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  round_id       uuid NOT NULL REFERENCES rounds(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  amount         numeric(38, 18) NOT NULL CHECK (amount >= 0),
  target_weight  numeric(9, 8) NOT NULL CHECK (target_weight >= 0 AND target_weight <= 1),
  prev_weight    numeric(9, 8) NOT NULL CHECK (prev_weight  >= 0 AND prev_weight  <= 1),
  delta          numeric(9, 8) NOT NULL,
  trigger        allocation_trigger NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- attestations  (per-round; on-chain mirror, reconciled by chain_state)
-- value/value_decimals carry the ERC-8004 (int128 + uint8) shape.
-- ---------------------------------------------------------------------------
CREATE TABLE attestations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES agents(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  round_id        uuid NOT NULL REFERENCES rounds(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  value           numeric(39, 0) NOT NULL                 -- ERC-8004 int128
                    CHECK (value >= -170141183460469231731687303715884105728
                       AND value <=  170141183460469231731687303715884105727),
  value_decimals  smallint NOT NULL DEFAULT 0             -- ERC-8004 uint8
                    CHECK (value_decimals >= 0 AND value_decimals <= 255),
  tag1            text,
  tag2            text,
  feedback_uri    text,
  feedback_hash   text CHECK (feedback_hash IS NULL OR feedback_hash ~ '^0x[0-9a-fA-F]{64}$'),
  chain_state     chain_state NOT NULL DEFAULT 'optimistic',
  tx_hash         text CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  block_number    bigint CHECK (block_number IS NULL OR block_number >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_at    timestamptz,
  UNIQUE (agent_id, round_id)                              -- one attestation per agent per round
);

-- ---------------------------------------------------------------------------
-- kill_switch  (singleton: exactly one row, enforced by the id=1 PK + CHECK)
-- ---------------------------------------------------------------------------
CREATE TABLE kill_switch (
  id          smallint PRIMARY KEY DEFAULT 1,
  active      boolean NOT NULL DEFAULT false,
  reason      text,
  set_by      text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kill_switch_singleton CHECK (id = 1)
);

-- ---------------------------------------------------------------------------
-- Indexes for the P1.5 read patterns (leaderboard, agent detail, feeds).
-- ---------------------------------------------------------------------------
CREATE INDEX idx_agents_score_current        ON agents (score_current DESC);
CREATE INDEX idx_intents_agent_created       ON intents (agent_id, created_at DESC);
CREATE INDEX idx_intents_round               ON intents (round_id);
CREATE INDEX idx_policy_events_created       ON policy_events (created_at DESC);
CREATE INDEX idx_policy_events_round_created ON policy_events (round_id, created_at DESC);
CREATE INDEX idx_executions_intent          ON executions (intent_id);
CREATE INDEX idx_outcomes_agent_round       ON outcomes (agent_id, round_id);
CREATE INDEX idx_outcomes_round             ON outcomes (round_id);
CREATE INDEX idx_scores_round               ON scores (round_id);
CREATE INDEX idx_capital_alloc_agent_round  ON capital_allocations (agent_id, round_id);
CREATE INDEX idx_capital_alloc_round        ON capital_allocations (round_id);
CREATE INDEX idx_attestations_chain_state   ON attestations (chain_state);
