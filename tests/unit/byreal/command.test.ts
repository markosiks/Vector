import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import {
  buildAccountInfoCommand,
  buildPositionListCommand,
  buildSettlementCommand,
  ByrealCommandError,
} from '@/lib/rail/byreal/command';
import { BYREAL_MARKETS, resolveByrealMarket } from '@/lib/rail/byreal/markets';
import type { Intent } from '@/lib/intent/types';

/**
 * Unit: the Byreal market allow-list and the pure argv command builders (P2.1).
 * The builders never produce a shell string — they emit argv arrays — and the
 * allow-list is a strict subset of the referee whitelist. Heavy on the
 * defer-to-seed (`null`) and reject (`throw`) edges, light on the happy path.
 */

const OPEN_FIELDS = {
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
};

/** Build an Intent from loose fields, bypassing the discriminated-union literal check. */
function intent(overrides: Record<string, unknown> = {}): Intent {
  return { ...OPEN_FIELDS, ...overrides } as unknown as Intent;
}

describe('resolveByrealMarket / BYREAL_MARKETS', () => {
  test('maps whitelisted internal markets to CLI coins', () => {
    expect(resolveByrealMarket('BTC-PERP')).toEqual({ market: 'BTC-PERP', coin: 'BTC' });
    expect(resolveByrealMarket('ETH-PERP')).toEqual({ market: 'ETH-PERP', coin: 'ETH' });
  });

  test('returns undefined for an unknown or wrong-cased market', () => {
    expect(resolveByrealMarket('SOL-PERP')).toBeUndefined();
    expect(resolveByrealMarket('btc-perp')).toBeUndefined();
    expect(resolveByrealMarket('')).toBeUndefined();
  });

  test('the rail allow-list is a subset of the referee whitelist (invariant)', () => {
    const whitelist = new Set<string>(CONFIG.policy.market_whitelist);
    for (const m of BYREAL_MARKETS) expect(whitelist.has(m.market)).toBe(true);
  });
});

describe('buildSettlementCommand — defers (null) when not expressible', () => {
  test('transfer never reaches the rail', () => {
    expect(buildSettlementCommand(intent({ action: 'transfer', size: '5' }))).toBeNull();
  });

  test('an unmapped market defers to seed', () => {
    expect(buildSettlementCommand(intent({ market: 'SOL-PERP' }))).toBeNull();
  });

  test('a modify with no TP/SL is a no-op on the venue', () => {
    expect(buildSettlementCommand(intent({ action: 'modify' }))).toBeNull();
  });
});

describe('buildSettlementCommand — happy paths emit argv arrays', () => {
  test('open → order market <side> <size> <coin>', () => {
    const cmd = buildSettlementCommand(intent());
    expect(cmd?.market.coin).toBe('BTC');
    expect(cmd?.argv).toEqual(['order', 'market', 'long', '0.01', 'BTC']);
  });

  test('open with TP/SL appends the flags', () => {
    const cmd = buildSettlementCommand(intent({ tp: '70000', sl: '60000' }));
    expect(cmd?.argv).toEqual([
      'order',
      'market',
      'long',
      '0.01',
      'BTC',
      '--tp',
      '70000',
      '--sl',
      '60000',
    ]);
  });

  test('short side is passed through', () => {
    expect(buildSettlementCommand(intent({ side: 'short' }))?.argv[2]).toBe('short');
  });

  test('modify with TP/SL → position tpsl', () => {
    expect(buildSettlementCommand(intent({ action: 'modify', tp: '70000' }))?.argv).toEqual([
      'position',
      'tpsl',
      'BTC',
      '--tp',
      '70000',
    ]);
  });

  test('close → position close-market <coin> <size>', () => {
    expect(
      buildSettlementCommand(intent({ action: 'close', market: 'ETH-PERP', size: '1.5' }))?.argv,
    ).toEqual(['position', 'close-market', 'ETH', '1.5']);
  });
});

describe('buildSettlementCommand — rejects malformed numerics (defense in depth)', () => {
  test('a non-decimal size throws rather than smuggling an arg', () => {
    expect(() => buildSettlementCommand(intent({ size: '0.01; rm -rf /' }))).toThrow(
      ByrealCommandError,
    );
  });

  test('a non-decimal TP throws', () => {
    expect(() => buildSettlementCommand(intent({ tp: '$(whoami)' }))).toThrow(ByrealCommandError);
  });

  test('scientific notation is rejected (not canonical decimal)', () => {
    expect(() => buildSettlementCommand(intent({ size: '1e3' }))).toThrow(ByrealCommandError);
  });

  test('a negative size is rejected (cannot land in a positional slot as a flag)', () => {
    expect(() => buildSettlementCommand(intent({ size: '-1' }))).toThrow(ByrealCommandError);
  });

  test('a negative TP/SL is rejected', () => {
    expect(() => buildSettlementCommand(intent({ tp: '-70000' }))).toThrow(ByrealCommandError);
    expect(() => buildSettlementCommand(intent({ sl: '-60000' }))).toThrow(ByrealCommandError);
  });

  test('a zero size is rejected (no positive quantity to trade)', () => {
    expect(() => buildSettlementCommand(intent({ size: '0' }))).toThrow(ByrealCommandError);
  });
});

describe('read commands', () => {
  test('account info / position list argv', () => {
    expect(buildAccountInfoCommand()).toEqual(['account', 'info']);
    expect(buildPositionListCommand()).toEqual(['position', 'list']);
  });
});
