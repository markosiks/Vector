import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import type { Queryable } from '@/lib/db/types';
import { signIntent } from '@/lib/intent/sign';
import { runReferee } from '@/lib/referee/record';
import type { RefereeConfig, RefereeState } from '@/lib/referee/types';
import {
  TEST_PK,
  resolveTestSigner,
  transferInput,
  validOpenInput,
} from '@/tests/fixtures/intent-fixtures';

/**
 * Hard end-to-end scenarios for the referee (P1.1 §11): adversarial, extreme,
 * and concurrent inputs driven through `runReferee` against an in-memory event
 * sink that stands in for Neon. The bar: every decision is deterministic, in
 * domain, with the correct severity, and writes exactly one `policy_event`;
 * drains are always blocked.
 */

const POLICY = CONFIG.policy;
const NOW = new Date('2030-01-01T00:00:00.000Z');
const ttl = new Date(NOW.getTime() + 60_000).toISOString();
const validate = { resolveSigner: resolveTestSigner, now: NOW };
const IDS = {
  intent_id: '11111111-1111-1111-1111-111111111111',
  agent_id: '22222222-2222-2222-2222-222222222222',
  round_id: '33333333-3333-3333-3333-333333333333',
};

const cleanState = (over: Partial<RefereeState> = {}): RefereeState => ({
  killSwitch: { active: false },
  agent: { allocation: '100000', remaining_budget: '100000', drawdown: '0' },
  ...over,
});

/** In-memory event sink that records every persisted policy_event. */
class EventSink implements Queryable {
  public readonly events: Record<string, unknown>[] = [];
  async query<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    if (sql.startsWith('INSERT INTO policy_events') && params) {
      const cols = sql
        .slice(sql.indexOf('(') + 1, sql.indexOf(')'))
        .split(', ')
        .map((c) => c.trim());
      this.events.push(Object.fromEntries(cols.map((c, i) => [c, params[i]])));
    }
    const row = {
      id: '44444444-4444-4444-4444-444444444444',
      intent_id: IDS.intent_id,
      agent_id: IDS.agent_id,
      round_id: IDS.round_id,
      rule_fired: 'allow',
      decision: 'ALLOW',
      severity: 'none',
      detail_json: {},
      created_at: NOW,
    };
    return { rows: [row as R], rowCount: 1 };
  }
}

describe('e2e — mass parallel drain injection', () => {
  test('100 concurrent drains are all blocked, each writing one hard REJECT', async () => {
    const sink = new EventSink();
    const drains = Array.from({ length: 100 }, (_, i) =>
      signIntent(transferInput({ nonce: `d${i}`, ttl }), TEST_PK).then((signed) =>
        runReferee({ db: sink, input: signed, ids: IDS, state: cleanState(), validate }),
      ),
    );
    const results = await Promise.all(drains);
    for (const r of results) {
      expect(r.decision).toBe('REJECT');
      expect(r.severity).toBe('hard');
      expect(r.rule_fired).toBe('fresh_wallet_transfer_block');
    }
    expect(sink.events).toHaveLength(100);
    expect(sink.events.every((e) => e.decision === 'REJECT' && e.severity === 'hard')).toBe(true);
  });
});

describe('e2e — kill-switch race during evaluation', () => {
  test('each evaluation reflects the kill-switch state it was handed (deterministic)', async () => {
    const sink = new EventSink();
    const signed = await signIntent(validOpenInput({ ttl }), TEST_PK);
    const off = runReferee({
      db: sink,
      input: signed,
      ids: IDS,
      state: cleanState({ killSwitch: { active: false } }),
      validate,
    });
    const on = runReferee({
      db: sink,
      input: signed,
      ids: IDS,
      state: cleanState({ killSwitch: { active: true } }),
      validate,
    });
    const [offRes, onRes] = await Promise.all([off, on]);
    expect(offRes.decision).toBe('ALLOW');
    expect(onRes).toMatchObject({ decision: 'HALT', rule_fired: 'kill_switch' });
  });
});

describe('e2e — simultaneous violation of every rule resolves to the first', () => {
  test('kill switch wins over a drain, oversize, overleverage, broke, blown-drawdown intent', async () => {
    const sink = new EventSink();
    // A maximally-bad open: bad market, oversize, overleverage, no budget, blown drawdown, switch on.
    const signed = await signIntent(
      validOpenInput({ market: 'DOGE-PERP', size: 999_999, leverage: 99, ttl }),
      TEST_PK,
    );
    const res = await runReferee({
      db: sink,
      input: signed,
      ids: IDS,
      state: cleanState({
        killSwitch: { active: true },
        agent: { allocation: '1', remaining_budget: '0', drawdown: '0.99' },
      }),
      validate,
    });
    expect(res.rule_fired).toBe('kill_switch');
    // With the switch off, the market whitelist (next in order) decides.
    const res2 = await runReferee({
      db: sink,
      input: signed,
      ids: IDS,
      state: cleanState({ agent: { allocation: '1', remaining_budget: '0', drawdown: '0.99' } }),
      validate,
    });
    expect(res2.rule_fired).toBe('market_whitelist');
  });
});

describe('e2e — adversarial address representations cannot bypass the drain block', () => {
  const cfg: RefereeConfig = {
    ...POLICY,
    fresh_wallet_criteria: {
      ...POLICY.fresh_wallet_criteria,
      whitelist: ['0x000000000000000000000000000000000000beef'],
    },
  } as RefereeConfig;

  test('a whitelisted address passes only with a true (case-insensitive) match', async () => {
    const sink = new EventSink();
    const ok = await signIntent(
      transferInput({ target_address: '0x000000000000000000000000000000000000BEEF', ttl }),
      TEST_PK,
    );
    const okRes = await runReferee({
      db: sink,
      input: ok,
      ids: IDS,
      state: cleanState(),
      config: cfg,
      validate,
    });
    expect(okRes.decision).not.toBe('REJECT');

    // A different address (not the whitelisted one) is blocked, regardless of casing.
    const bad = await signIntent(
      transferInput({
        target_address: '0x000000000000000000000000000000000000dEaD',
        nonce: '99',
        ttl,
      }),
      TEST_PK,
    );
    const badRes = await runReferee({
      db: sink,
      input: bad,
      ids: IDS,
      state: cleanState(),
      config: cfg,
      validate,
    });
    expect(badRes).toMatchObject({ decision: 'REJECT', severity: 'hard' });
  });
});

describe('e2e — extreme magnitudes', () => {
  test('a near-zero in-bounds open is allowed; an astronomically large one is clipped', async () => {
    const sink = new EventSink();
    const tiny = await signIntent(validOpenInput({ size: '0.0000001', leverage: 1, ttl }), TEST_PK);
    expect(
      (await runReferee({ db: sink, input: tiny, ids: IDS, state: cleanState(), validate }))
        .decision,
    ).toBe('ALLOW');

    // Large but *storable* (20 integer digits = numeric(38,18) max) and over the
    // 10_000 trade cap ⇒ the firewall CLIPs it down to the cap.
    const huge = await signIntent(
      validOpenInput({ size: '99999999999999999999', leverage: 3, nonce: '2', ttl }),
      TEST_PK,
    );
    const r = await runReferee({
      db: sink,
      input: huge,
      ids: IDS,
      state: cleanState({ agent: { allocation: '1e30', remaining_budget: '1e30', drawdown: '0' } }),
      validate,
    });
    expect(r).toMatchObject({ decision: 'CLIP', rule_fired: 'size_cap' });

    // Astronomically large enough to be *unstorable* (>20 integer digits) ⇒ the
    // gate rejects it at the storability bound before it can reach the clip, so
    // the persisting INSERT never sees a value that would overflow numeric(38,18).
    const unstorable = await signIntent(
      validOpenInput({ size: '99999999999999999999999999', leverage: 3, nonce: '3', ttl }),
      TEST_PK,
    );
    expect(
      (
        await runReferee({
          db: sink,
          input: unstorable,
          ids: IDS,
          state: cleanState({ agent: { allocation: '1e30', remaining_budget: '1e30', drawdown: '0' } }),
          validate,
        })
      ).decision,
    ).toBe('REJECT');
  });
});
