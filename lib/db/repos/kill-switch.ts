import { killSwitchRow, type KillSwitchRow } from '../schema';
import type { Queryable } from '../types';
import { selectOne } from './_shared';

/**
 * The kill switch is a singleton row (id = 1, enforced in SQL). Reads and the
 * operator toggle both target that single row; the toggle upserts so the first
 * call materializes it and later calls update it in place.
 */

export function getKillSwitch(db: Queryable): Promise<KillSwitchRow | null> {
  return selectOne(db, 'SELECT * FROM kill_switch WHERE id = 1', [], killSwitchRow);
}

/** Set the kill switch state (operator action). Upserts the singleton row. */
export async function setKillSwitch(
  db: Queryable,
  input: { active: boolean; reason?: string | null; set_by?: string | null },
): Promise<KillSwitchRow> {
  const { rows } = await db.query(
    `INSERT INTO kill_switch (id, active, reason, set_by, updated_at)
     VALUES (1, $1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE
       SET active = EXCLUDED.active,
           reason = EXCLUDED.reason,
           set_by = EXCLUDED.set_by,
           updated_at = now()
     RETURNING *`,
    [input.active, input.reason ?? null, input.set_by ?? null],
  );
  return killSwitchRow.parse(rows[0]);
}
