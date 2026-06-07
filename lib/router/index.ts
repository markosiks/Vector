/**
 * Capital router (P1.3, architecture.txt §6.2).
 *
 * `route()` is the pure, deterministic, conservation-exact allocation function;
 * `record.ts` derives its inputs from the `agents` cache and the previous
 * allocation and writes the `capital_allocations` ledger. `fixed-point.ts` holds
 * the integer apportionment that guarantees `Σ amount == pool_size`.
 */
export { route } from './route';
export {
  defaultRouterConfig,
  deriveRouterAgents,
  loadPrevAllocations,
  recordRoute,
  type DeriveRouterAgentsOptions,
  type RecordRouteArgs,
  type RecordRouteResult,
} from './record';
export { apportion, formatUnits, ratioToFixed, subtractFixed, toUnits } from './fixed-point';
export type {
  Allocation,
  PrevAllocation,
  RouteResult,
  RouterAgent,
  RouterConfig,
  RouterState,
  RouteTrigger,
} from './types';
