import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { settleWithFallback, type RailFill, type RailRequest } from '@/lib/replay/rail';
import { createByrealRail } from '@/lib/rail/byreal/adapter';
import type { ByrealCredentials } from '@/lib/rail/byreal/credentials';
import type { Intent } from '@/lib/intent/types';
import type { SeedOutcome } from '@/seed';

/**
 * End-to-end (no DB): the Byreal rail behind the real fallback seam, driven by a
 * real CLI subprocess stub. Proves the arc-level guarantee from §6.5 — whatever
 * the venue does (fill, error envelope, garbage, crash, transfer it must refuse),
 * `settleWithFallback` either records the live fill or degrades silently to the
 * deterministic seeded outcome. The arc never stalls.
 */

const CREDS: ByrealCredentials = {
  agentKey: 'k',
  walletAddress: `0x${'a'.repeat(40)}`,
  network: 'testnet',
};

const SEED_OUTCOME: SeedOutcome = {
  pnl_realized: '100',
  pnl_marked: '0',
  capital_at_risk: '1000',
  fees: '1',
  position_delta: '1',
  drawdown: '0',
};
const SEED_FILL: RailFill = { status: 'filled', outcome: SEED_OUTCOME, rail_order_id: 'seed-x' };

const OPEN: Intent = {
  agent_id: 'a',
  action: 'open',
  market: 'BTC-PERP',
  side: 'long',
  size: '0.01',
  leverage: '2',
  max_slippage: '0.01',
  nonce: '1',
  ttl: '60',
  signature: `0x${'1'.repeat(130)}`,
} as Intent;

const dir = mkdtempSync(join(tmpdir(), 'byreal-e2e-'));
function stub(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

const req = (intent: Intent): RailRequest => ({ intent, agentId: 'a', tickIndex: 0, intentHash: 'h' });

describe('byreal rail behind settleWithFallback — the arc never stalls', () => {
  test('a real fill is recorded (degraded:false)', async () => {
    // Branches on argv: a `position list` returns a book; anything else fills.
    const cli = stub(
      'venue.cjs',
      `const a = process.argv.slice(2);
       const isPos = a.includes('position') && a.includes('list');
       const data = isPos
         ? [{ coin: 'BTC', positionValue: '650', unrealizedPnl: '12', szi: '0.01' }]
         : { filled: { oid: 'order-7', totalSz: '0.01', avgPx: '65000' }, fee: '0.5' };
       console.log(JSON.stringify({ success: true, data }));`,
    );
    const rail = createByrealRail({ credentials: CREDS, cliPath: cli });
    const { fill, degraded } = await settleWithFallback(rail, req(OPEN), SEED_FILL);
    expect(degraded).toBe(false);
    expect(fill.rail_order_id).toBe('order-7');
    expect(fill.outcome.capital_at_risk).toBe('650');
  });

  test('an error envelope degrades to the seed (degraded:true)', async () => {
    const cli = stub(
      'err.cjs',
      `console.log(JSON.stringify({ success: false, error: { code: 'NO_LIQUIDITY', message: 'empty' } }));
       process.exit(1);`,
    );
    const rail = createByrealRail({ credentials: CREDS, cliPath: cli });
    const { fill, degraded } = await settleWithFallback(rail, req(OPEN), SEED_FILL);
    expect(degraded).toBe(true);
    expect(fill).toEqual(SEED_FILL);
  });

  test('garbage stdout degrades to the seed', async () => {
    const cli = stub('garbage.cjs', `console.log('not json at all <<>>');`);
    const rail = createByrealRail({ credentials: CREDS, cliPath: cli });
    const { degraded } = await settleWithFallback(rail, req(OPEN), SEED_FILL);
    expect(degraded).toBe(true);
  });

  test('a crashing CLI (no output) degrades to the seed', async () => {
    const cli = stub('crash.cjs', `process.exit(3);`);
    const rail = createByrealRail({ credentials: CREDS, cliPath: cli });
    const { degraded } = await settleWithFallback(rail, req(OPEN), SEED_FILL);
    expect(degraded).toBe(true);
  });

  test('a hanging CLI is killed by the timeout and degrades to the seed', async () => {
    const cli = stub('hang.cjs', `setTimeout(() => {}, 60_000);`);
    const rail = createByrealRail({ credentials: CREDS, cliPath: cli, timeoutMs: 200 });
    const { degraded } = await settleWithFallback(rail, req(OPEN), SEED_FILL);
    expect(degraded).toBe(true);
  });

  test('a transfer never reaches the venue and degrades to the seed', async () => {
    const marker = join(dir, 'transfer-invoked');
    const cli = stub(
      'transfer.cjs',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1');
       console.log(JSON.stringify({ success: true, data: { oid: 'x' } }));`,
    );
    const rail = createByrealRail({ credentials: CREDS, cliPath: cli });
    const transfer = { agent_id: 'a', action: 'transfer', size: '5' } as unknown as Intent;
    const { fill, degraded } = await settleWithFallback(rail, req(transfer), SEED_FILL);
    expect(degraded).toBe(true);
    expect(fill).toEqual(SEED_FILL);
    // The CLI must not have been spawned at all for a transfer.
    expect(existsSync(marker)).toBe(false);
  });
});
