import { describe, expect, test } from 'bun:test';

import type { ByrealCredentials } from '@/lib/rail/byreal/credentials';
import type { ByrealCliResult } from '@/lib/rail/byreal/cli';
import type { ByrealCliRunner } from '@/lib/rail/byreal/adapter';
import { createByrealRail, ByrealRailError } from '@/lib/rail/byreal/adapter';
import { ByrealParseError } from '@/lib/rail/byreal/envelope';
import { createMemoryIdempotencyStore } from '@/lib/rail/byreal/idempotency';
import type { Intent } from '@/lib/intent/types';
import type { RailRequest } from '@/lib/replay/rail';

/**
 * Unit: the Byreal rail adapter (P2.1) driven by an injected CLI runner — no
 * subprocess. Covers the ALLOW/CLIP-only structural guarantees (transfers and
 * unmapped markets defer), the happy fill, error/parse-miss throws (caller falls
 * back to seed), idempotency (no double order), and best-effort position reads.
 */

const CREDS: ByrealCredentials = {
  agentKey: 'k',
  walletAddress: `0x${'a'.repeat(40)}`,
  network: 'testnet',
};

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

function envelope(data: unknown): ByrealCliResult {
  return { stdout: JSON.stringify({ success: true, data }), stderr: '', code: 0 };
}

/** A recording CLI runner that answers `order` and `position` commands. */
function mockRunner(
  handlers: {
    order?: ByrealCliResult | (() => never);
    position?: ByrealCliResult | (() => never);
  } = {},
): { run: ByrealCliRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: ByrealCliRunner = async (subArgv) => {
    calls.push([...subArgv]);
    const kind = subArgv[0] === 'position' && subArgv[1] === 'list' ? 'position' : 'order';
    const h = handlers[kind];
    if (typeof h === 'function') {
      h(); // throws
      throw new Error('unreachable');
    }
    if (h !== undefined) return h;
    if (kind === 'position') {
      return envelope([{ coin: 'BTC', positionValue: '650', unrealizedPnl: '12', szi: '0.01' }]);
    }
    return envelope({ filled: { oid: 42, totalSz: '0.01', avgPx: '65000' }, fee: '0.5' });
  };
  return { run, calls };
}

function req(intent: Intent, intentHash = 'default-hash'): RailRequest {
  return {
    intent,
    agentId: 'a',
    tickIndex: 0,
    intentHash,
  };
}

describe('createByrealRail — construction safety', () => {
  test('refuses mainnet credentials without allowMainnet', () => {
    expect(() =>
      createByrealRail({ credentials: { ...CREDS, network: 'mainnet' }, runCli: mockRunner().run }),
    ).toThrow(/mainnet/);
  });

  test('allows mainnet only with explicit opt-in', () => {
    expect(() =>
      createByrealRail({
        credentials: { ...CREDS, network: 'mainnet' },
        allowMainnet: true,
        runCli: mockRunner().run,
      }),
    ).not.toThrow();
  });
});

describe('execute — defers to seed (null) without calling the CLI', () => {
  test('a transfer never reaches the venue', async () => {
    const m = mockRunner();
    const rail = createByrealRail({ credentials: CREDS, runCli: m.run });
    const intent = { agent_id: 'a', action: 'transfer', size: '5' } as unknown as Intent;
    expect(await rail.execute(req(intent))).toBeNull();
    expect(m.calls).toHaveLength(0);
  });

  test('an unmapped market defers', async () => {
    const m = mockRunner();
    const rail = createByrealRail({ credentials: CREDS, runCli: m.run });
    expect(
      await rail.execute(req({ ...OPEN, market: 'SOL-PERP' } as unknown as Intent)),
    ).toBeNull();
    expect(m.calls).toHaveLength(0);
  });
});

describe('execute — happy fill', () => {
  test('opens, reads the position, and maps the outcome', async () => {
    const m = mockRunner();
    const rail = createByrealRail({ credentials: CREDS, runCli: m.run });
    const fill = await rail.execute(req(OPEN));
    expect(fill).not.toBeNull();
    expect(fill?.status).toBe('filled');
    expect(fill?.rail_order_id).toBe('42');
    expect(fill?.outcome).toMatchObject({
      pnl_marked: '12',
      capital_at_risk: '650',
      fees: '0.5',
      position_delta: '0.01',
      drawdown: '0',
    });
    expect(m.calls[0]).toEqual(['order', 'market', 'long', '0.01', 'BTC']);
    expect(m.calls[1]).toEqual(['position', 'list']);
  });

  test('readPosition:false skips the position read and zeroes those figures', async () => {
    const m = mockRunner();
    const rail = createByrealRail({ credentials: CREDS, runCli: m.run, readPosition: false });
    const fill = await rail.execute(req(OPEN));
    expect(m.calls).toHaveLength(1);
    expect(fill?.outcome.capital_at_risk).toBe('0');
    expect(fill?.outcome.pnl_marked).toBe('0');
  });

  test('a failing position read does not fail the settle (best-effort)', async () => {
    const m = mockRunner({
      position: () => {
        throw new Error('read timeout');
      },
    });
    const rail = createByrealRail({ credentials: CREDS, runCli: m.run });
    const fill = await rail.execute(req(OPEN));
    expect(fill?.status).toBe('filled');
    expect(fill?.outcome.capital_at_risk).toBe('0');
  });
});

describe('execute — failures surface for the seed fallback', () => {
  test('a non-success envelope throws ByrealRailError carrying the code', async () => {
    const m = mockRunner({
      order: {
        stdout: JSON.stringify({
          success: false,
          error: { code: 'NO_LIQUIDITY', message: 'empty' },
        }),
        stderr: '',
        code: 1,
      },
    });
    const rail = createByrealRail({ credentials: CREDS, runCli: m.run });
    const err = await rail.execute(req(OPEN)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ByrealRailError);
    expect((err as ByrealRailError).code).toBe('NO_LIQUIDITY');
  });

  test('an order result with no id throws ByrealParseError', async () => {
    const m = mockRunner({ order: envelope({ filled: { totalSz: '1' } }) });
    const rail = createByrealRail({ credentials: CREDS, runCli: m.run });
    await expect(rail.execute(req(OPEN))).rejects.toBeInstanceOf(ByrealParseError);
  });
});

describe('execute — idempotency by intent_hash', () => {
  test('a repeat of the same Intent reuses the first fill, no second order', async () => {
    const m = mockRunner();
    const rail = createByrealRail({
      credentials: CREDS,
      runCli: m.run,
      idempotency: createMemoryIdempotencyStore(),
    });
    const first = await rail.execute(req(OPEN, 'hash-1'));
    const second = await rail.execute(req(OPEN, 'hash-1'));
    expect(second).toEqual(first);
    // First call placed order+position (2); the second short-circuited (still 2).
    expect(m.calls).toHaveLength(2);
  });

  test('a different intent_hash places a new order', async () => {
    const m = mockRunner();
    const rail = createByrealRail({
      credentials: CREDS,
      runCli: m.run,
      idempotency: createMemoryIdempotencyStore(),
    });
    await rail.execute(req(OPEN, 'hash-1'));
    await rail.execute(req(OPEN, 'hash-2'));
    expect(m.calls.filter((c) => c[0] === 'order')).toHaveLength(2);
  });

  // B-01 regression: concurrent calls with the same intentHash must not place
  // two orders. The promise-memo stores the in-progress promise before the CLI
  // call resolves, so the second caller awaits the same promise.
  test('concurrent execute() calls with the same hash fire only one order', async () => {
    let orderCallCount = 0;
    // A CLI runner that resolves asynchronously (via a microtask) so both
    // concurrent callers can enter execute() before the first one resolves.
    const run: ByrealCliRunner = async (subArgv) => {
      const kind = subArgv[0] === 'position' && subArgv[1] === 'list' ? 'position' : 'order';
      if (kind === 'order') orderCallCount += 1;
      await Promise.resolve(); // yield to allow the second call to enter
      if (kind === 'position') {
        return { stdout: JSON.stringify({ success: true, data: [] }), stderr: '', code: 0 };
      }
      return {
        stdout: JSON.stringify({
          success: true,
          data: { filled: { oid: 1, totalSz: '0.01', avgPx: '65000' }, fee: '0' },
        }),
        stderr: '',
        code: 0,
      };
    };

    const rail = createByrealRail({
      credentials: CREDS,
      runCli: run,
      idempotency: createMemoryIdempotencyStore(),
    });

    // Fire both calls concurrently with the same hash — neither awaits.
    const [fillA, fillB] = await Promise.all([
      rail.execute(req(OPEN, 'race-hash')),
      rail.execute(req(OPEN, 'race-hash')),
    ]);

    // Both callers must receive the same fill object.
    expect(fillA).toEqual(fillB);
    // Only ONE order call must have been made.
    expect(orderCallCount).toBe(1);
  });
});

describe('execute — B-03 error message sanitization', () => {
  test('control characters are stripped from CLI error messages', async () => {
    const m = mockRunner({
      order: {
        stdout: JSON.stringify({
          success: false,
          error: { code: 'BAD', message: 'error\x00with\x1fnull\nbytes' },
        }),
        stderr: '',
        code: 1,
      },
    });
    const rail = createByrealRail({ credentials: CREDS, runCli: m.run });
    const err = await rail.execute(req(OPEN, 'h')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ByrealRailError);
    expect((err as ByrealRailError).message).toBe('errorwithnullbytes');
  });

  test('CLI error messages are capped at 256 characters', async () => {
    const longMsg = 'x'.repeat(400);
    const m = mockRunner({
      order: {
        stdout: JSON.stringify({
          success: false,
          error: { code: 'LONG', message: longMsg },
        }),
        stderr: '',
        code: 1,
      },
    });
    const rail = createByrealRail({ credentials: CREDS, runCli: m.run });
    const err = await rail.execute(req(OPEN, 'h')).catch((e: unknown) => e);
    expect((err as ByrealRailError).message.length).toBeLessThanOrEqual(256);
  });

  test('a missing error.message falls back to the default message', async () => {
    // success:false with no error field at all → envelope.error is undefined
    // → sanitizeCliError(undefined) → 'byreal order failed'
    const m = mockRunner({
      order: {
        stdout: JSON.stringify({ success: false }),
        stderr: '',
        code: 1,
      },
    });
    const rail = createByrealRail({ credentials: CREDS, runCli: m.run });
    const err = await rail.execute(req(OPEN, 'h')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ByrealRailError);
    expect((err as ByrealRailError).message).toBe('byreal order failed');
  });
});
