import { describe, expect, test } from 'bun:test';

import { selectFlashes, summarizeFlashes } from '@/lib/arena/flash';
import { makePolicyEvent } from '@/tests/fixtures/arena-fixtures';

const EMPTY: ReadonlySet<string> = new Set();

describe('selectFlashes', () => {
  test('flashes REJECT and HALT, ignores ALLOW and CLIP', () => {
    const events = [
      makePolicyEvent({ id: 'e1', decision: 'REJECT' }),
      makePolicyEvent({ id: 'e2', decision: 'ALLOW' }),
      makePolicyEvent({ id: 'e3', decision: 'HALT' }),
      makePolicyEvent({ id: 'e4', decision: 'CLIP' }),
    ];
    const { flashes, seen } = selectFlashes(events, EMPTY);
    expect(flashes.map((f) => f.eventId)).toEqual(['e1', 'e3']);
    expect([...seen].sort()).toEqual(['e1', 'e3']);
  });

  test('de-dupes across polls — an event flashes exactly once', () => {
    const events = [makePolicyEvent({ id: 'e1', decision: 'REJECT' })];
    const first = selectFlashes(events, EMPTY);
    expect(first.flashes).toHaveLength(1);
    const second = selectFlashes(events, first.seen);
    expect(second.flashes).toHaveLength(0);
  });

  test('a new head event flashes while the prior one stays seen', () => {
    const poll1 = [makePolicyEvent({ id: 'e1', decision: 'REJECT' })];
    const s1 = selectFlashes(poll1, EMPTY);
    const poll2 = [
      makePolicyEvent({ id: 'e2', decision: 'HALT' }),
      makePolicyEvent({ id: 'e1', decision: 'REJECT' }),
    ];
    const s2 = selectFlashes(poll2, s1.seen);
    expect(s2.flashes.map((f) => f.eventId)).toEqual(['e2']);
  });

  test('prunes seen to ids still on the page (bounded memory)', () => {
    const s1 = selectFlashes([makePolicyEvent({ id: 'old', decision: 'REJECT' })], EMPTY);
    const s2 = selectFlashes([makePolicyEvent({ id: 'new', decision: 'HALT' })], s1.seen);
    // 'old' scrolled off the page → dropped from seen.
    expect(s2.seen.has('old')).toBe(false);
    expect(s2.seen.has('new')).toBe(true);
  });

  test('carries agent id and decision through', () => {
    const { flashes } = selectFlashes(
      [makePolicyEvent({ id: 'e1', decision: 'HALT', agent_id: 'agent-x' })],
      EMPTY,
    );
    expect(flashes[0]).toMatchObject({ eventId: 'e1', agentId: 'agent-x', decision: 'HALT' });
  });

  test('a row duplicated within one page flashes only once (regression)', () => {
    const dup = makePolicyEvent({ id: 'e1', decision: 'REJECT' });
    const { flashes, seen } = selectFlashes([dup, dup], EMPTY);
    expect(flashes).toHaveLength(1);
    expect(seen.size).toBe(1);
  });

  test('empty feed → no flashes, empty seen', () => {
    const { flashes, seen } = selectFlashes([], EMPTY);
    expect(flashes).toEqual([]);
    expect(seen.size).toBe(0);
  });
});

describe('summarizeFlashes', () => {
  test('collapses a burst into one active flash with a count and agent set', () => {
    const { flashes } = selectFlashes(
      [
        makePolicyEvent({ id: 'e1', decision: 'REJECT', agent_id: 'a' }),
        makePolicyEvent({ id: 'e2', decision: 'HALT', agent_id: 'a' }),
        makePolicyEvent({ id: 'e3', decision: 'REJECT', agent_id: 'b' }),
      ],
      EMPTY,
    );
    const summary = summarizeFlashes(flashes);
    expect(summary.active).toBe(true);
    expect(summary.count).toBe(3);
    expect([...summary.agentIds].sort()).toEqual(['a', 'b']);
  });

  test('no flashes → inactive', () => {
    const summary = summarizeFlashes([]);
    expect(summary).toEqual({ active: false, count: 0, agentIds: new Set() });
  });
});
