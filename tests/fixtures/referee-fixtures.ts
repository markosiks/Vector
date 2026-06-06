import { signedIntentSchema } from '@/lib/intent/schema';
import type { Intent } from '@/lib/intent/types';
import type { RefereeState } from '@/lib/referee/types';

/**
 * Deterministic fixtures for the referee tests (P1.1). Intents are built through
 * {@link signedIntentSchema} so they are already canonical/normalized exactly as
 * the validator hands them to the referee. The signature is a well-formed dummy:
 * the referee never checks signatures (that is P0.3's job), so its value is
 * irrelevant to policy evaluation.
 */

export const DUMMY_SIG = ('0x' + 'a'.repeat(130)) as `0x${string}`;

const TTL = '2999-01-01T00:00:00Z';

type Over = Record<string, unknown>;

export const openIntent = (o: Over = {}): Intent =>
  signedIntentSchema.parse({
    action: 'open',
    agent_id: 'agent-001',
    market: 'BTC-PERP',
    side: 'long',
    size: 1000,
    leverage: 3,
    max_slippage: 0.01,
    nonce: '1',
    ttl: TTL,
    signature: DUMMY_SIG,
    ...o,
  });

export const closeIntent = (o: Over = {}): Intent =>
  signedIntentSchema.parse({
    action: 'close',
    agent_id: 'agent-001',
    market: 'ETH-PERP',
    size: 500,
    max_slippage: 0.02,
    nonce: '2',
    ttl: TTL,
    signature: DUMMY_SIG,
    ...o,
  });

export const transferIntent = (o: Over = {}): Intent =>
  signedIntentSchema.parse({
    action: 'transfer',
    agent_id: 'agent-001',
    size: 250,
    target_address: '0x000000000000000000000000000000000000dEaD',
    nonce: '3',
    ttl: TTL,
    signature: DUMMY_SIG,
    ...o,
  });

/** A clean, permissive state: switch off, full budget, no drawdown. */
export const cleanState = (o: Partial<RefereeState> = {}): RefereeState => ({
  killSwitch: { active: false },
  agent: { allocation: '100000', remaining_budget: '100000', drawdown: '0' },
  ...o,
});
