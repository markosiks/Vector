import { describe, expect, test } from 'bun:test';

import type { IntentDto, PolicyEventDto } from '@/lib/api/dto';
import type { PolicyDecision, PolicySeverity } from '@/lib/db/schema';
import {
  correlateIntents,
  decisionRank,
  decisionTone,
  severityRank,
} from '@/lib/credibility/referee';

/**
 * The correlation joins intents to referee decisions by `intent_id`, surfaces
 * the *most severe* decision per intent, drops events with no listed intent, and
 * leaves un-refereed intents with `worst: null`. Precedence: HALT > REJECT >
 * CLIP > ALLOW, severity as the tie-break.
 */

const intent = (id: string): IntentDto => ({
  id,
  round_id: '00000000-0000-0000-0000-0000000000aa',
  intent_hash: '0xabc',
  action: 'open',
  market: 'BTC-PERP',
  side: 'long',
  size: '1.5',
  leverage: '5',
  tp: null,
  sl: null,
  max_slippage: null,
  target_address: null,
  created_at: '2026-06-07T12:00:00.000Z',
});

const event = (
  id: string,
  intent_id: string,
  decision: PolicyDecision,
  severity: PolicySeverity,
  created_at = '2026-06-07T12:00:00.000Z',
): PolicyEventDto => ({
  id,
  intent_id,
  agent_id: '00000000-0000-0000-0000-0000000000a1',
  round_id: '00000000-0000-0000-0000-0000000000aa',
  rule_fired: 'rule',
  decision,
  severity,
  detail: null,
  created_at,
});

describe('rank + tone helpers', () => {
  test('decision precedence is HALT > REJECT > CLIP > ALLOW', () => {
    expect(decisionRank('HALT')).toBeGreaterThan(decisionRank('REJECT'));
    expect(decisionRank('REJECT')).toBeGreaterThan(decisionRank('CLIP'));
    expect(decisionRank('CLIP')).toBeGreaterThan(decisionRank('ALLOW'));
  });

  test('severity precedence is halt > hard > soft > none', () => {
    expect(severityRank('halt')).toBeGreaterThan(severityRank('hard'));
    expect(severityRank('hard')).toBeGreaterThan(severityRank('soft'));
    expect(severityRank('soft')).toBeGreaterThan(severityRank('none'));
  });

  test('tone maps each decision', () => {
    expect(decisionTone('ALLOW')).toBe('ok');
    expect(decisionTone('CLIP')).toBe('warn');
    expect(decisionTone('REJECT')).toBe('danger');
    expect(decisionTone('HALT')).toBe('critical');
  });
});

describe('correlateIntents', () => {
  test('surfaces the dominant decision when an intent trips several rules', () => {
    const i = intent('i1');
    const rows = correlateIntents(
      [i],
      [event('e1', 'i1', 'CLIP', 'soft'), event('e2', 'i1', 'REJECT', 'hard')],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.events).toHaveLength(2);
    expect(rows[0]!.worst!.decision).toBe('REJECT'); // outranks CLIP
    expect(rows[0]!.events[0]!.decision).toBe('REJECT'); // worst-first ordering
  });

  test('an intent with no referee event has worst = null', () => {
    const rows = correlateIntents([intent('i1')], []);
    expect(rows[0]!.worst).toBeNull();
    expect(rows[0]!.events).toHaveLength(0);
  });

  test('events whose intent is not listed are dropped (no orphan decisions)', () => {
    const rows = correlateIntents([intent('i1')], [event('e1', 'i-missing', 'HALT', 'halt')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.worst).toBeNull();
  });

  test('preserves the input intent order', () => {
    const rows = correlateIntents([intent('i2'), intent('i1')], []);
    expect(rows.map((r) => r.intent.id)).toEqual(['i2', 'i1']);
  });

  test('is deterministic for equal decision/severity (stable tie-break)', () => {
    const i = intent('i1');
    const a = correlateIntents(
      [i],
      [event('eB', 'i1', 'REJECT', 'hard'), event('eA', 'i1', 'REJECT', 'hard')],
    );
    const b = correlateIntents(
      [i],
      [event('eA', 'i1', 'REJECT', 'hard'), event('eB', 'i1', 'REJECT', 'hard')],
    );
    expect(a[0]!.worst!.id).toBe(b[0]!.worst!.id);
  });
});
