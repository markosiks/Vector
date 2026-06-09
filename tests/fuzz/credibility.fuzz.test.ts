import { describe, expect, test } from 'bun:test';

import type { IntentDto, PolicyEventDto, ScoreDto } from '@/lib/api/dto';
import { CHAIN_STATE, POLICY_DECISION, POLICY_SEVERITY } from '@/lib/db/schema';
import {
  breakdownFrom,
  buildEwmaSeries,
  chainStateMeta,
  correlateIntents,
  decisionRank,
  explorerBlockUrl,
  explorerTxUrl,
  isStuckOptimistic,
  safeComponents,
  sparklineGeometry,
} from '@/lib/credibility';

/**
 * Fuzz the credibility logic. The invariant under any input — random bytes, a
 * corrupt DTO, NaN/Infinity components, a malformed hash — is a *total*
 * function: it returns an in-contract value or `null`/empty, never throws, never
 * emits a malformed URL, and never lets a non-finite number reach the geometry.
 */

function randString(len: number): string {
  const alphabet = 'abcdef0123456789xX-_.:/\\\'"; ()=*+%<>{}[]\t\n0Z٥0０';
  let out = '';
  for (let i = 0; i < len; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function randNumberish(): unknown {
  const r = Math.random();
  if (r < 0.15) return Number.NaN;
  if (r < 0.3) return Number.POSITIVE_INFINITY;
  if (r < 0.45) return Number.NEGATIVE_INFINITY;
  if (r < 0.6) return (Math.random() - 0.5) * 1e6;
  if (r < 0.75) return Math.random();
  if (r < 0.85) return String(Math.random());
  return null;
}

describe('explorer builders never emit a malformed link', () => {
  test('random tx/block inputs resolve to a valid URL or null', () => {
    for (let i = 0; i < 5000; i += 1) {
      const raw = Math.random() < 0.5 ? randString(Math.floor(Math.random() * 80)) : null;
      const tx = explorerTxUrl(raw);
      if (tx !== null) {
        expect(tx).toMatch(/\/tx\/0x[0-9a-fA-F]{64}$/);
        expect(tx.includes('//tx')).toBe(false);
      }
      const block = explorerBlockUrl(raw);
      if (block !== null) expect(block).toMatch(/\/block\/[0-9]+$/);
    }
  });
});

describe('safeComponents + breakdownFrom are total', () => {
  test('any object of numberish values yields a clamped raw or null, never throws', () => {
    for (let i = 0; i < 5000; i += 1) {
      const input: Record<string, unknown> = {
        perf: randNumberish(),
        w: randNumberish(),
        policy: randNumberish(),
        dd: randNumberish(),
      };
      if (Math.random() < 0.2) input['extra'] = 1; // schema must reject extras
      const safe = safeComponents(input);
      const b = breakdownFrom(input);
      if (safe === null) {
        expect(b).toBeNull();
      } else {
        expect(b).not.toBeNull();
        expect(b!.raw).toBeGreaterThanOrEqual(0);
        expect(b!.raw).toBeLessThanOrEqual(100);
        expect(Number.isFinite(b!.raw)).toBe(true);
      }
    }
  });

  test('garbage non-objects are rejected to null', () => {
    for (const g of [null, undefined, 'x', 42, [], true, Number.NaN]) {
      expect(breakdownFrom(g)).toBeNull();
    }
  });
});

describe('chain-state is total over arbitrary strings', () => {
  test('chainStateMeta never throws and isStuckOptimistic stays boolean', () => {
    const now = new Date('2026-06-09T12:00:00.000Z');
    for (let i = 0; i < 3000; i += 1) {
      const state = Math.random() < 0.5 ? randString(6) : CHAIN_STATE[i % CHAIN_STATE.length]!;
      expect(() => chainStateMeta(state)).not.toThrow();
      const created =
        Math.random() < 0.3 ? randString(10) : new Date(now.getTime() - i * 1000).toISOString();
      const stuck = isStuckOptimistic({ chain_state: state as never, created_at: created }, now);
      expect(typeof stuck).toBe('boolean');
      // Only optimistic rows can ever be stuck.
      if (state !== 'optimistic') expect(stuck).toBe(false);
    }
  });
});

describe('EWMA geometry never produces NaN', () => {
  test('random score strings yield finite pixels and well-formed paths', () => {
    for (let i = 0; i < 2000; i += 1) {
      const n = Math.floor(Math.random() * 12);
      const scores: ScoreDto[] = Array.from({ length: n }, (_, k) => ({
        round_id: `00000000-0000-0000-0000-${String(k).padStart(12, '0')}`,
        raw_r: '0',
        score_r: Math.random() < 0.3 ? randString(5) : String((Math.random() - 0.2) * 140),
        components: null,
        created_at: '2026-06-07T12:00:00.000Z',
      }));
      const geo = sparklineGeometry(buildEwmaSeries(scores), {
        width: 100,
        height: 100,
        padding: 4,
      });
      for (const p of geo.points) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
      expect(geo.path.includes('NaN')).toBe(false);
      expect(geo.areaPath.includes('NaN')).toBe(false);
      if (geo.points.length === 0) expect(geo.path).toBe('');
    }
  });
});

describe('correlateIntents is total and picks the true maximum', () => {
  const mkIntent = (id: string): IntentDto => ({
    id,
    round_id: '00000000-0000-0000-0000-0000000000aa',
    intent_hash: '0x',
    action: 'open',
    market: null,
    side: null,
    size: null,
    leverage: null,
    tp: null,
    sl: null,
    max_slippage: null,
    target_address: null,
    created_at: '2026-06-07T12:00:00.000Z',
  });

  test('worst is the max by decision rank for any random event set', () => {
    for (let i = 0; i < 2000; i += 1) {
      const intents = Array.from({ length: 1 + (i % 4) }, (_, k) => mkIntent(`i${k}`));
      const events: PolicyEventDto[] = Array.from({ length: i % 7 }, (_, k) => ({
        id: `e${i}-${k}`,
        intent_id: `i${Math.floor(Math.random() * 5)}`, // some will be orphans
        agent_id: 'a',
        round_id: '00000000-0000-0000-0000-0000000000aa',
        rule_fired: 'r',
        decision: POLICY_DECISION[Math.floor(Math.random() * POLICY_DECISION.length)]!,
        severity: POLICY_SEVERITY[Math.floor(Math.random() * POLICY_SEVERITY.length)]!,
        detail: null,
        created_at: '2026-06-07T12:00:00.000Z',
      }));
      const rows = correlateIntents(intents, events);
      expect(rows).toHaveLength(intents.length);
      for (const row of rows) {
        if (row.worst === null) {
          expect(row.events).toHaveLength(0);
        } else {
          const maxRank = Math.max(...row.events.map((e) => decisionRank(e.decision)));
          expect(decisionRank(row.worst.decision)).toBe(maxRank);
        }
        // No orphan: every event correlated here belongs to this intent.
        for (const e of row.events) expect(e.intent_id).toBe(row.intent.id);
      }
    }
  });
});
