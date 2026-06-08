import { describe, expect, test } from 'bun:test';

import { parseEnvelope, ByrealParseError } from '@/lib/rail/byreal/envelope';
import {
  buildOutcome,
  findPosition,
  parseOrderResult,
} from '@/lib/rail/byreal/parse';

/**
 * Unit: turning untrusted CLI stdout into a typed envelope and mapping the
 * payload onto Vector's execution/outcome shape (P2.1). Edge-weighted: ANSI,
 * banners, truncation, garbage, missing ids, and the credibility-figure defaults.
 */

function ok(data: unknown): string {
  return JSON.stringify({ success: true, meta: { version: '0.3.7' }, data });
}

describe('parseEnvelope', () => {
  test('parses a success envelope', () => {
    const env = parseEnvelope(ok({ x: 1 }));
    expect(env.success).toBe(true);
    expect(env.data).toEqual({ x: 1 });
  });

  test('parses an error envelope (success:false)', () => {
    const env = parseEnvelope(
      JSON.stringify({ success: false, error: { code: 'NO_LIQUIDITY', message: 'empty book' } }),
    );
    expect(env.success).toBe(false);
    expect(env.error?.code).toBe('NO_LIQUIDITY');
  });

  test('ignores a leading banner / trailing newline around the JSON', () => {
    const env = parseEnvelope(`byreal-perps v0.3.7\n${ok({ ok: true })}\n\n`);
    expect(env.success).toBe(true);
  });

  test('strips ANSI colour codes', () => {
    const env = parseEnvelope(`\u001b[32m${ok({ ok: true })}\u001b[0m`);
    expect(env.success).toBe(true);
  });

  test('does not close early on a brace inside a JSON string', () => {
    const env = parseEnvelope(ok({ note: 'a } brace { in a string' }));
    expect((env.data as { note: string }).note).toBe('a } brace { in a string');
  });

  test('throws on output with no JSON object', () => {
    expect(() => parseEnvelope('no json here')).toThrow(ByrealParseError);
  });

  test('throws on truncated/unbalanced JSON', () => {
    expect(() => parseEnvelope('{"success": true, "data": {')).toThrow(ByrealParseError);
  });

  test('throws on invalid JSON', () => {
    expect(() => parseEnvelope('{ not: valid, json }')).toThrow(ByrealParseError);
  });

  test('throws on an envelope missing the required `success` flag', () => {
    expect(() => parseEnvelope(JSON.stringify({ data: {} }))).toThrow(ByrealParseError);
  });

  test('throws on output past the size bound', () => {
    expect(() => parseEnvelope(`{"success":true,"x":"${'a'.repeat(1_000_001)}"}`)).toThrow(
      ByrealParseError,
    );
  });
});

describe('parseOrderResult', () => {
  test('a fully-filled order → status filled, id, size', () => {
    const r = parseOrderResult({ filled: { oid: 12345, totalSz: '0.01', avgPx: '65000' } });
    expect(r).toMatchObject({ orderId: '12345', status: 'filled', filledSize: '0.01' });
  });

  test('a partially-filled order (filled + resting) → partial', () => {
    const r = parseOrderResult({
      filled: { oid: 1, totalSz: '0.5', avgPx: '65000' },
      resting: { oid: 2 },
    });
    expect(r.status).toBe('partial');
  });

  test('a fully-resting order (no fill) → sent', () => {
    const r = parseOrderResult({ resting: { oid: 7 } });
    expect(r).toMatchObject({ orderId: '7', status: 'sent', filledSize: '0' });
  });

  test('falls back to top-level oid / orderId', () => {
    expect(parseOrderResult({ oid: 9 }).orderId).toBe('9');
    expect(parseOrderResult({ orderId: 'abc' }).orderId).toBe('abc');
  });

  test('captures realized PnL and fees when present', () => {
    const r = parseOrderResult({ oid: 1, closedPnl: '12.5', fee: '0.7' });
    expect(r).toMatchObject({ realizedPnl: '12.5', fees: '0.7' });
  });

  test('defaults missing economics to 0 rather than failing', () => {
    const r = parseOrderResult({ oid: 1 });
    expect(r).toMatchObject({ realizedPnl: '0', fees: '0', filledSize: '0' });
  });

  test('throws when no order id can be found (no settlement to record)', () => {
    expect(() => parseOrderResult({ filled: { totalSz: '1' } })).toThrow(ByrealParseError);
  });

  test('throws on a wholly unrecognized shape', () => {
    expect(() => parseOrderResult('not an object')).toThrow(ByrealParseError);
  });
});

describe('findPosition', () => {
  const positions = [
    { coin: 'BTC', szi: '0.01', positionValue: '650', unrealizedPnl: '12.3' },
    { coin: 'ETH', szi: '-2', positionValue: '7000', unrealizedPnl: '-5' },
  ];

  test('finds a coin in an array payload', () => {
    expect(findPosition(positions, 'BTC')).toEqual({
      notional: '650',
      markedPnl: '12.3',
      size: '0.01',
    });
  });

  test('finds a coin in a { positions: [...] } payload and keeps the short sign', () => {
    expect(findPosition({ positions }, 'ETH')).toEqual({
      notional: '7000',
      markedPnl: '-5',
      size: '-2',
    });
  });

  test('returns undefined when flat on the coin', () => {
    expect(findPosition(positions, 'SOL')).toBeUndefined();
  });

  test('returns undefined on an unrecognized payload', () => {
    expect(findPosition('nope', 'BTC')).toBeUndefined();
  });
});

describe('buildOutcome', () => {
  const order = { orderId: '1', status: 'filled' as const, filledSize: '0.01', realizedPnl: '0', fees: '0.5' };

  test('open long: positive delta, position economics, drawdown always 0', () => {
    const o = buildOutcome({
      order,
      position: { notional: '650', markedPnl: '12.3', size: '0.01' },
      openSide: 'long',
      isClose: false,
    });
    expect(o).toEqual({
      pnl_realized: '0',
      pnl_marked: '12.3',
      capital_at_risk: '650',
      fees: '0.5',
      position_delta: '0.01',
      drawdown: '0',
    });
  });

  test('open short: negative position delta', () => {
    const o = buildOutcome({ order, openSide: 'short', isClose: false });
    expect(o.position_delta).toBe('-0.01');
  });

  test('close: negative delta and zeroed economics without a position read', () => {
    const o = buildOutcome({ order: { ...order, realizedPnl: '20' }, isClose: true });
    expect(o).toMatchObject({
      position_delta: '-0.01',
      pnl_realized: '20',
      pnl_marked: '0',
      capital_at_risk: '0',
      drawdown: '0',
    });
  });
});
