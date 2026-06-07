import type { FlashSelection, FlashTrigger, PolicyEventDto } from './types';

/**
 * Red-flash selection from the policy-event feed.
 *
 * The feed (`GET /api/policy-events`, newest first) is the red-alert channel.
 * A block is visible "within one poll" — frame-exact is impossible under SWR
 * polling, and that one-interval window *is* the precise meaning of "the moment
 * of the block". Each poll we pick the REJECT/HALT events we have not flashed
 * before, identified by their immutable event `id`, and remember the ids so a
 * row re-render or a paging walk never re-fires the same alert.
 *
 * Robustness the demo depends on:
 *  - **De-dup across polls.** The `seen` set is threaded poll-to-poll; an event
 *    flashes exactly once even though it stays at the feed head for several polls.
 *  - **Burst collapse.** A series of REJECT/HALT in one poll returns as a set the
 *    caller can render as a single screen-level flash (with a count), not a
 *    strobing stack.
 *  - **Bounded memory.** `seen` is pruned to the ids still on the page plus the
 *    new flashes, so a long-running screen does not grow the set without bound.
 */

const FLASHING_DECISIONS = new Set<'REJECT' | 'HALT'>(['REJECT', 'HALT']);

function isFlashing(e: PolicyEventDto): e is PolicyEventDto & { decision: 'REJECT' | 'HALT' } {
  return FLASHING_DECISIONS.has(e.decision as 'REJECT' | 'HALT');
}

/**
 * Select the red-flash triggers for this poll given the events currently on the
 * feed page and the ids already flashed. Returns the newly-seen REJECT/HALT
 * events (in feed order, newest first) and the next `seen` set to thread into the
 * following poll.
 *
 * The next `seen` is `{ ids of every flashing event on the page } ∪ { new flashes }`
 * — it never carries an id that has scrolled off the page, so memory stays bounded
 * to roughly one page. An ALLOW/CLIP event is never a flash and never enters `seen`.
 */
export function selectFlashes(
  events: readonly PolicyEventDto[],
  seen: ReadonlySet<string>,
): FlashSelection {
  const flashes: FlashTrigger[] = [];
  const nextSeen = new Set<string>();
  for (const e of events) {
    if (!isFlashing(e)) continue;
    // Guard against both prior polls (`seen`) *and* a row duplicated within this
    // same page (`nextSeen`): a noisy feed response must not flash one block twice.
    if (!seen.has(e.id) && !nextSeen.has(e.id)) {
      flashes.push({
        eventId: e.id,
        agentId: e.agent_id,
        decision: e.decision,
        createdAt: e.created_at,
      });
    }
    nextSeen.add(e.id);
  }
  return { flashes, seen: nextSeen };
}

/** A screen-level summary of one poll's flashes for the global red-flash overlay. */
export interface FlashSummary {
  /** Whether to fire the screen-level red-flash this poll. */
  readonly active: boolean;
  /** How many REJECT/HALT events fired this poll (a burst is one flash, many events). */
  readonly count: number;
  /** Agent ids implicated this poll, for per-row flashes. */
  readonly agentIds: ReadonlySet<string>;
}

/** Collapse a poll's flash triggers into a single screen-level summary. */
export function summarizeFlashes(flashes: readonly FlashTrigger[]): FlashSummary {
  const agentIds = new Set<string>();
  for (const f of flashes) agentIds.add(f.agentId);
  return { active: flashes.length > 0, count: flashes.length, agentIds };
}
