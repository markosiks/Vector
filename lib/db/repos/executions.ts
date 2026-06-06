import {
  executionRow,
  type ExecutionRail,
  type ExecutionRow,
  type ExecutionStatus,
} from '../schema';
import type { Queryable } from '../types';
import { insertOne, selectOne } from './_shared';

/** Fields accepted when recording an execution on a rail. */
export interface NewExecution {
  intent_id: string;
  status: ExecutionStatus;
  rail?: ExecutionRail;
  rail_order_id?: string | null;
  request_json?: unknown;
  response_json?: unknown;
}

export function insertExecution(db: Queryable, input: NewExecution): Promise<ExecutionRow> {
  return insertOne(
    db,
    'executions',
    {
      intent_id: input.intent_id,
      status: input.status,
      rail: input.rail,
      rail_order_id: input.rail_order_id,
      request_json: input.request_json,
      response_json: input.response_json,
    },
    executionRow,
  );
}

export function getExecution(db: Queryable, id: string): Promise<ExecutionRow | null> {
  return selectOne(db, 'SELECT * FROM executions WHERE id = $1', [id], executionRow);
}
