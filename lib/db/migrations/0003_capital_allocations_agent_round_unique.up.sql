-- 0003 — Durable one-row-per-(agent, round) for capital_allocations.
--
-- §6.2 routes a fixed pool whose per-agent `amount`s sum to `pool_size` exactly,
-- once per round. Every *other* per-(agent, round) ledger already anchors that
-- "exactly once" in SQL — `scores` and `attestations` carry
-- UNIQUE (agent_id, round_id) — but `capital_allocations` shipped with only the
-- non-unique `idx_capital_alloc_agent_round`, so a settlement retry or a
-- concurrent pass could append a second full row set and silently double the
-- round's `Σ amount`, corrupting both the conservation audit and the prev-state
-- the next pass routes from.
--
-- Anchor it at the source of truth: a UNIQUE (agent_id, round_id) constraint
-- makes a duplicate allocation fail atomically in a single statement, which the
-- record path turns into idempotency via
-- INSERT ... ON CONFLICT (agent_id, round_id) DO NOTHING
-- (lib/db/repos/capital-allocations.ts:insertCapitalAllocation), mirroring
-- scores.insertScore. The constraint creates its own backing index, so the
-- redundant non-unique index is dropped.
--
-- `delta` (= target_weight − prev_weight) is logically bounded to [-1, 1]; the
-- original DDL constrained `amount`/`target_weight`/`prev_weight` but left
-- `delta` unbounded beyond its numeric(9,8) scale. Add the range CHECK as
-- defense-in-depth so a future bug cannot persist an out-of-range delta.

ALTER TABLE capital_allocations
  ADD CONSTRAINT capital_allocations_agent_round_unique UNIQUE (agent_id, round_id),
  ADD CONSTRAINT capital_allocations_delta_range CHECK (delta >= -1 AND delta <= 1);

DROP INDEX IF EXISTS idx_capital_alloc_agent_round;
