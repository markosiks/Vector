/**
 * Minimal query surface shared by the data layer.
 *
 * Both a Neon `Pool` and a `PoolClient` satisfy this, so repositories and the
 * migration runner can be handed either a pooled connection or a single client
 * bound to a transaction. Repos take a `Queryable` as their first argument,
 * which keeps them unit-testable (inject a fake) without `mock.module`.
 */
export interface Queryable {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}
