# ADR 0002 — Migration tooling: a thin SQL runner, no ORM

- Status: accepted (P0.2)
- Context: §7 needs the full Neon schema with forward + rollback migrations, a
  typed repository layer, and idempotent seed/reset.

## Decision

Use a **minimal SQL-file migration runner built on the Neon client the repo
already uses**, and a **hand-written typed repository layer** — no ORM and no
external migration framework.

- Migrations are paired `NNNN_name.up.sql` / `.down.sql` files applied by
  `lib/db/migrate.ts`, which keeps a `schema_migrations` ledger, runs each
  migration in its own transaction, and takes a `pg_advisory_lock` so concurrent
  runners serialize.
- Repositories (`lib/db/repos/*`) build parameterized statements and validate
  rows with the zod schemas already in the stack.

## Why (reuse-check)

We considered `drizzle-kit` and `node-pg-migrate` first, per the brief.

- **drizzle / any ORM** contradicts the brief's explicit "no superfluous ORM
  abstractions" for the repo layer, and would add a second schema source of
  truth alongside the SQL DDL.
- **node-pg-migrate** is built around the `pg` TCP client; the repo standardized
  on `@neondatabase/serverless` in P0.1 (ADR 0001). Introducing a second driver
  to run migrations fights that decision.
- The behaviors these tools would buy us — up/down, idempotency, a concurrency
  lock — are satisfied by Postgres primitives we reuse directly: a ledger table,
  per-migration transactions, and `pg_advisory_lock`. The runner is ~150 lines
  with no new dependency, and stays consistent with the repo's raw-SQL + zod
  idiom.

## Consequences

- The SQL DDL is the single source of truth; `lib/db/schema.ts` mirrors its enum
  domains/row shapes for typing only.
- Rollback is first-class (explicit `.down.sql`), unlike forward-only ORM
  generators.
- We own the runner, so its invariants (atomicity, lock, idempotency) are
  covered directly by the e2e suite against real Neon.
