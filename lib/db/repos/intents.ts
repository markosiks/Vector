import { intentRow, type IntentAction, type IntentRow, type IntentSide } from '../schema';
import type { Queryable } from '../types';
import { insertOne, num, selectMany, selectOne, type NumericInput } from './_shared';

/** Fields accepted when recording an intent. */
export interface NewIntent {
  round_id: string;
  agent_id: string;
  intent_hash: string;
  action: IntentAction;
  market?: string | null;
  side?: IntentSide | null;
  size?: NumericInput | null;
  leverage?: NumericInput | null;
  tp?: NumericInput | null;
  sl?: NumericInput | null;
  max_slippage?: NumericInput | null;
  target_address?: string | null;
  nonce?: string | null;
  ttl?: Date | null;
  signature?: string | null;
  raw_json?: unknown;
}

const maybeNum = (v: NumericInput | null | undefined): string | null | undefined =>
  v === null || v === undefined ? v : num(v);

export function insertIntent(db: Queryable, input: NewIntent): Promise<IntentRow> {
  return insertOne(
    db,
    'intents',
    {
      round_id: input.round_id,
      agent_id: input.agent_id,
      intent_hash: input.intent_hash,
      action: input.action,
      market: input.market,
      side: input.side,
      size: maybeNum(input.size),
      leverage: maybeNum(input.leverage),
      tp: maybeNum(input.tp),
      sl: maybeNum(input.sl),
      max_slippage: maybeNum(input.max_slippage),
      target_address: input.target_address,
      nonce: input.nonce,
      ttl: input.ttl,
      signature: input.signature,
      raw_json: input.raw_json,
    },
    intentRow,
  );
}

export function getIntent(db: Queryable, id: string): Promise<IntentRow | null> {
  return selectOne(db, 'SELECT * FROM intents WHERE id = $1', [id], intentRow);
}

/** Agent-detail read: an agent's most recent intents, newest first. */
export function listIntentsByAgent(
  db: Queryable,
  agentId: string,
  limit = 100,
): Promise<IntentRow[]> {
  return selectMany(
    db,
    'SELECT * FROM intents WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2',
    [agentId, limit],
    intentRow,
  );
}
