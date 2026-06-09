import { z } from 'zod';

/**
 * Input contract for the operator console's per-agent HALT control
 * (`POST /api/operator/agents/:id/status`). Kept in its own pure module — free
 * of any `server-only` wiring — so the load-bearing `'gated'` exclusion can be
 * unit-tested directly.
 *
 * The console exposes exactly two operator-settable states: `halted` and
 * `active` (resume). `'gated'` is a valid DB status but is **deliberately
 * excluded** here: it does NOT stop intent execution (the referee HALTs only on
 * `status === 'halted'`), it merely gates the agent out of capital allocation
 * (P1.3) and is the scoring engine's exclusive domain. Accepting it on the
 * safety console would hand the operator a HALT that silently does not halt.
 */
export const OPERATOR_SETTABLE_STATUS = ['active', 'halted'] as const;

export type OperatorSettableStatus = (typeof OPERATOR_SETTABLE_STATUS)[number];

export const operatorStatusBody = z.object({ status: z.enum(OPERATOR_SETTABLE_STATUS) }).strict();
