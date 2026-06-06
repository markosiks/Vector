import { describe, expect, test } from 'bun:test';

import { resetData } from '@/lib/db/seed';
import type { Queryable } from '@/lib/db/types';

/** Fake that reports a fixed current_schema and records whether TRUNCATE ran. */
class SchemaDb implements Queryable {
  public truncated = false;
  constructor(private readonly schema: string) {}
  async query<R = Record<string, unknown>>(
    sql: string,
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    if (sql.includes('current_schema')) {
      return { rows: [{ schema: this.schema } as R], rowCount: 1 };
    }
    if (sql.startsWith('TRUNCATE')) this.truncated = true;
    return { rows: [], rowCount: 0 };
  }
}

describe('resetData', () => {
  test('refuses to truncate when current_schema is public', async () => {
    const db = new SchemaDb('public');
    await expect(resetData(db)).rejects.toThrow(/public/);
    expect(db.truncated).toBe(false);
  });

  test('truncates inside a dedicated (non-public) schema', async () => {
    const db = new SchemaDb('vec_test_abc');
    await resetData(db);
    expect(db.truncated).toBe(true);
  });
});
