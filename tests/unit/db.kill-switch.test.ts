import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { readKillSwitchState } from '@/lib/db/repos/kill-switch';
import type { Queryable } from '@/lib/db/types';

/**
 * Unit: `readKillSwitchState` is the live pipeline's boundary onto operator
 * state. Each input class — present-and-active, present-and-inactive, no row,
 * and a read error — must collapse to a deterministic flag, and the error class
 * must fail OPEN (never throw, never HALT), because a transient read fault
 * silently halting every agent is the worse failure for the demo spine.
 */

/** A `Queryable` whose single read returns `rows` (or throws if `rows` is an Error). */
function reader(rows: Record<string, unknown>[] | Error): Queryable {
  return {
    query: async () => {
      if (rows instanceof Error) throw rows;
      return { rows: rows as never[], rowCount: rows.length };
    },
  };
}

const ROW = { id: 1, set_by: 'operator', updated_at: new Date() };

afterEach(() => {
  mock.restore();
});

describe('readKillSwitchState', () => {
  test('an active row surfaces active + reason', async () => {
    const r = reader([{ ...ROW, active: true, reason: 'incident-42' }]);
    expect(await readKillSwitchState(r)).toEqual({ active: true, reason: 'incident-42' });
  });

  test('an inactive row surfaces inactive', async () => {
    const r = reader([{ ...ROW, active: false, reason: null }]);
    expect(await readKillSwitchState(r)).toEqual({ active: false, reason: null });
  });

  test('a missing singleton row fails open (inactive)', async () => {
    expect(await readKillSwitchState(reader([]))).toEqual({ active: false, reason: null });
  });

  test('a read error fails open and never throws', async () => {
    const spy = spyOn(console, 'error').mockImplementation(() => undefined);
    const r = reader(new Error('connection terminated unexpectedly'));
    expect(await readKillSwitchState(r)).toEqual({ active: false, reason: null });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('the error log carries the error name but not its message', async () => {
    const spy = spyOn(console, 'error').mockImplementation(() => undefined);
    const err = new Error('DATABASE_URL=postgres://secret@host/db');
    err.name = 'ConnError';
    await readKillSwitchState(reader(err));
    const logged = String(spy.mock.calls[0]?.[0] ?? '');
    expect(logged).toContain('ConnError');
    expect(logged).not.toContain('secret');
  });

  test('a malformed row fails open rather than propagating a parse error', async () => {
    // `active` missing → killSwitchRow.parse throws inside getKillSwitch; the
    // fail-open wrapper must absorb it just like a connection error.
    const spy = spyOn(console, 'error').mockImplementation(() => undefined);
    const r = reader([{ id: 1, reason: null, set_by: null, updated_at: new Date() }]);
    expect(await readKillSwitchState(r)).toEqual({ active: false, reason: null });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
