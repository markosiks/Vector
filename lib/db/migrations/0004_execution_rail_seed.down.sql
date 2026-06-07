-- 0004 — rollback: remove the `seed` value from the `execution_rail` enum.
--
-- Postgres has no `ALTER TYPE ... DROP VALUE`, so the reverse recreates the enum
-- without `seed` and re-points the `executions.rail` column at it. The cast
-- `rail::text::execution_rail` fails loudly if any row still uses `seed` — a
-- rollback that would silently drop live data should not succeed; reset that
-- data first. Wrapped in a guard so a re-run (or a rollback of a never-fully-
-- applied migration) is a no-op, matching the IF-EXISTS idempotency of 0002/0003.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'execution_rail'
       AND e.enumlabel = 'seed'
  ) THEN
    ALTER TYPE execution_rail RENAME TO execution_rail_old;
    CREATE TYPE execution_rail AS ENUM ('byreal');
    ALTER TABLE executions ALTER COLUMN rail DROP DEFAULT;
    ALTER TABLE executions
      ALTER COLUMN rail TYPE execution_rail USING rail::text::execution_rail;
    ALTER TABLE executions ALTER COLUMN rail SET DEFAULT 'byreal';
    DROP TYPE execution_rail_old;
  END IF;
END $$;
