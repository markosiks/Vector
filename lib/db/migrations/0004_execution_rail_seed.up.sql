-- 0004 — Add the `seed` execution rail (P1.4 deterministic demo spine).
--
-- §6.5 runs the demo arc through the *real* referee/scoring/router but with a
-- deterministic, seeded execution rail instead of a live venue. Each seeded fill
-- is recorded as a real `executions` row so the outcome is traceable end to end
-- (intent → execution → outcome), exactly like a live rail — the only chosen
-- alternative was a NULL `outcomes.execution_id`, which would have severed that
-- audit link. To keep the synthetic fill a first-class, queryable row we add a
-- dedicated `seed` value to the `execution_rail` enum rather than overloading
-- `byreal`, so a reader can always tell a replayed fill from a live one.
--
-- `IF NOT EXISTS` makes the forward migration idempotent. Adding an enum value
-- is non-transactional-use only: the value is added here and first *used* by
-- later statements/transactions, never within this migration.

ALTER TYPE execution_rail ADD VALUE IF NOT EXISTS 'seed';
