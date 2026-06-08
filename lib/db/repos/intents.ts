import { z } from 'zod';

import { intentRow, type IntentAction, type IntentRow, type IntentSide } from '../schema';
import type { Queryable } from '../types';
import {
  insertOne,
  insertOneOrNull,
  num,
  selectMany,
  selectOne,
  type NumericInput,
} from './_shared';

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

/** The `intents` column→value map shared by the plain and reserving inserts. */
const intentColumns = (input: NewIntent): Record<string, unknown> => ({
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
});

export function insertIntent(db: Queryable, input: NewIntent): Promise<IntentRow> {
  return insertOne(db, 'intents', intentColumns(input), intentRow);
}

/**
 * Insert an Intent while atomically reserving its `(agent_id, nonce)` against
 * the `intents_agent_nonce_unique` constraint (migration 0002). Returns the new
 * row, or `null` when an Intent with the same `(agent_id, nonce)` already
 * exists — i.e. a replay.
 *
 * This is the durable anti-replay guarantee the validator's pure `isNonceUsed`
 * read (validate.ts step c) cannot give on its own: the read is check-then-act
 * (a TOCTOU window under concurrency) and process-local, whereas this reserve is
 * decided by the database in a single statement and survives restarts and
 * multiple instances. An Intent with a NULL `nonce` never conflicts (Postgres
 * treats NULLs as distinct) and always inserts.
 */
export function insertIntentReserving(db: Queryable, input: NewIntent): Promise<IntentRow | null> {
  return insertOneOrNull(db, 'intents', intentColumns(input), intentRow, {
    onConflictDoNothing: ['agent_id', 'nonce'],
  });
}

/**
 * Has this `(agent_id, nonce)` already been recorded? A durable, DB-backed
 * read suitable as the validator's `ValidateOptions.isNonceUsed`. `agentId`
 * is the `agents.id` uuid (the `intents.agent_id` FK), not the Intent's string
 * `agent_id`. A NULL `nonce` is never considered used.
 */
export async function isNonceUsed(db: Queryable, agentId: string, nonce: string): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM intents WHERE agent_id = $1 AND nonce = $2 LIMIT 1',
    [agentId, nonce],
  );
  return rows.length > 0;
}

export function getIntent(db: Queryable, id: string): Promise<IntentRow | null> {
  return selectOne(db, 'SELECT * FROM intents WHERE id = $1', [id], intentRow);
}

/**
 * The intent hashes an agent submitted in one round, oldest first — the audit
 * trail folded into a round's attestation detail document. Ordered by
 * `created_at, id` so the list (and therefore the detail hash) is deterministic
 * even when several intents share a tick's `created_at`.
 */
export async function listIntentHashesByAgentRound(
  db: Queryable,
  agentId: string,
  roundId: string,
): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT intent_hash FROM intents
      WHERE agent_id = $1 AND round_id = $2
      ORDER BY created_at ASC, id ASC`,
    [agentId, roundId],
  );
  return rows.map((r) => z.string().parse((r as { intent_hash: unknown }).intent_hash));
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
