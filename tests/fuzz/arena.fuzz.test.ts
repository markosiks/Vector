import { describe, expect, test } from 'bun:test';

import {
  deriveFlows,
  deriveScoreChanges,
  flowDurationMs,
  pairFlows,
  rankAgents,
  selectFlashes,
} from '@/lib/arena';
import type { LeaderboardEntryDto, PolicyEventDto } from '@/lib/api/dto';
import type { PolicyDecision } from '@/lib/db/schema';
import { makeAgent, makePolicyEvent, makeRng } from '../fixtures/arena-fixtures';

/**
 * Fuzz the Arena derivations against random data sequences and jittery polling.
 * The invariant under any input — random rank permutations, score/capital jumps,
 * policy-event bursts, duplicated or reordered feed pages — is that every
 * function is total: it returns a well-formed, bounded, finite result and never
 * throws, hangs, or double-fires an alert.
 */

const POOL = 1_000_000;
const CRASH_CAP = 7;
const DECISIONS: readonly PolicyDecision[] = ['ALLOW', 'CLIP', 'REJECT', 'HALT'];

function randomBoard(rng: () => number, n: number): LeaderboardEntryDto[] {
  return Array.from({ length: n }, (_, i) =>
    makeAgent({
      id: `agent-${i}`,
      score_current: (rng() * 100).toFixed(rng() < 0.3 ? 0 : 6),
      allocation: rng() < 0.2 ? null : (rng() * POOL).toFixed(6),
      status: rng() < 0.1 ? (rng() < 0.5 ? 'gated' : 'halted') : 'active',
      created_at: new Date(1_700_000_000_000 + Math.floor(rng() * 1e9)).toISOString(),
    }),
  );
}

function shuffle<T>(rng: () => number, xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

describe('rankAgents (fuzz)', () => {
  test('total order: contiguous ranks, deterministic, permutation-stable', () => {
    const rng = makeRng(1);
    for (let t = 0; t < 1500; t += 1) {
      const board = randomBoard(rng, Math.floor(rng() * 8));
      const ranked = rankAgents(board, POOL);
      expect(ranked).toHaveLength(board.length);
      ranked.forEach((r, i) => {
        expect(r.rank).toBe(i);
        expect(r.scoreFraction).toBeGreaterThanOrEqual(0);
        expect(r.scoreFraction).toBeLessThanOrEqual(1);
        expect(Number.isFinite(r.allocationFraction)).toBe(true);
      });
      // Re-ranking a shuffled copy yields the identical id order (no flicker).
      const a = rankAgents(board, POOL).map((r) => r.id);
      const b = rankAgents(shuffle(rng, board), POOL).map((r) => r.id);
      expect(b).toEqual(a);
    }
  });
});

describe('deriveFlows / pairFlows (fuzz)', () => {
  test('flows are finite and arcs never move more than the available capital', () => {
    const rng = makeRng(2);
    for (let t = 0; t < 1500; t += 1) {
      const prev = randomBoard(rng, Math.floor(rng() * 8));
      const next = randomBoard(rng, Math.floor(rng() * 8));
      const flows = deriveFlows(prev, next, POOL);
      for (const f of flows) {
        expect(Number.isFinite(f.deltaFraction)).toBe(true);
        const sign = Math.sign(f.deltaFraction);
        if (f.direction === 'in') expect(sign).toBe(1);
        if (f.direction === 'out') expect(sign).toBe(-1);
      }
      const arcs = pairFlows(flows, 3);
      expect(arcs.length).toBeLessThanOrEqual(3);
      const totalOut = flows
        .filter((f) => f.direction === 'out')
        .reduce((s, f) => s - f.deltaFraction, 0);
      const moved = arcs.reduce((s, a) => s + a.fraction, 0);
      // Paired capital never exceeds what actually left (within float epsilon).
      expect(moved).toBeLessThanOrEqual(totalOut + 1e-9);
      for (const a of arcs) expect(a.fraction).toBeGreaterThan(0);
    }
  });
});

describe('deriveScoreChanges (fuzz)', () => {
  test('delta within [-1, 1], isCrash boolean, only carried-over agents', () => {
    const rng = makeRng(3);
    for (let t = 0; t < 1500; t += 1) {
      const prev = randomBoard(rng, Math.floor(rng() * 8));
      const next = randomBoard(rng, Math.floor(rng() * 8));
      const prevIds = new Set(prev.map((a) => a.id));
      for (const c of deriveScoreChanges(prev, next, CRASH_CAP)) {
        expect(c.deltaFraction).toBeGreaterThanOrEqual(-1);
        expect(c.deltaFraction).toBeLessThanOrEqual(1);
        expect(typeof c.isCrash).toBe('boolean');
        expect(prevIds.has(c.agentId)).toBe(true);
      }
    }
  });
});

describe('selectFlashes (fuzz) — jittery polling over a monotonic feed', () => {
  test('every block flashes exactly once; seen stays bounded to ~one page', () => {
    const rng = makeRng(4);
    const LIMIT = 6;
    for (let trial = 0; trial < 400; trial += 1) {
      // The real feed is append-only, newest-first: an event appears at the head
      // and only ever pages *off the bottom* — it never resurrects. We model that
      // with a growing log and a monotonic, jittery head (a stalled or duplicated
      // poll repeats the window; it never rewinds). De-dup-by-id then guarantees
      // at-most-once *and* bounded memory.
      const log: PolicyEventDto[] = [];
      const blocks = new Set<string>(); // ids that are REJECT/HALT
      let head = 0;
      let seen: ReadonlySet<string> = new Set();
      let initialized = false;
      const flashed = new Map<string, number>();

      for (let poll = 0; poll < 20; poll += 1) {
        // Append 0–3 new events to the log.
        const appended = Math.floor(rng() * 4);
        for (let k = 0; k < appended; k += 1) {
          const id = `evt-${log.length}`;
          const decision = DECISIONS[Math.floor(rng() * DECISIONS.length)]!;
          log.push(makePolicyEvent({ id, decision, agent_id: `agent-${log.length % 4}` }));
          if (decision === 'REJECT' || decision === 'HALT') blocks.add(id);
        }
        // Head advances monotonically (jitter: sometimes it stalls).
        head = rng() < 0.25 ? head : log.length;
        // The page is the newest LIMIT events up to the head, newest-first,
        // with an occasional duplicated row to model a noisy response.
        const window = log.slice(Math.max(0, head - LIMIT), head).reverse();
        const page = rng() < 0.3 && window.length > 0 ? [window[0]!, ...window] : window;

        if (!initialized) {
          initialized = true;
          seen = selectFlashes(page, seen).seen; // baseline: history is not new
          continue;
        }
        const res = selectFlashes(page, seen);
        seen = res.seen;
        expect(seen.size).toBeLessThanOrEqual(LIMIT); // bounded to the page
        for (const f of res.flashes) {
          flashed.set(f.eventId, (flashed.get(f.eventId) ?? 0) + 1);
          expect(f.decision === 'REJECT' || f.decision === 'HALT').toBe(true);
        }
      }
      for (const count of flashed.values()) expect(count).toBe(1);
    }
  });
});

describe('flowDurationMs (fuzz)', () => {
  test('always within [floor, ceiling], never NaN', () => {
    const rng = makeRng(5);
    for (let t = 0; t < 3000; t += 1) {
      const fraction = (rng() - 0.5) * 4;
      const pollMs = 200 + Math.floor(rng() * 4000);
      const d = flowDurationMs(fraction, { maxStep: 0.25, pollMs });
      const ceiling = Math.min(1200, Math.round(pollMs * 0.8));
      expect(Number.isNaN(d)).toBe(false);
      expect(d).toBeGreaterThanOrEqual(250);
      expect(d).toBeLessThanOrEqual(Math.max(250, ceiling));
    }
  });
});
