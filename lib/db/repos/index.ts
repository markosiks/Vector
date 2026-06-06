/**
 * Repository layer for the Vector data model. Each module exposes typed,
 * parameterized insert/select helpers for one table; all take a `Queryable`
 * (a pool or a transaction client) as their first argument.
 */
export * from './agents';
export * from './rounds';
export * from './intents';
export * from './policy-events';
export * from './executions';
export * from './outcomes';
export * from './scores';
export * from './capital-allocations';
export * from './attestations';
export * from './kill-switch';
