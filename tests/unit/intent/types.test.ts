import { describe, expect, test } from 'bun:test';

import { isTradeAction } from '@/lib/intent/types';

describe('isTradeAction', () => {
  test('is true only for actions that carry a side/leverage', () => {
    expect(isTradeAction('open')).toBe(true);
    expect(isTradeAction('modify')).toBe(true);
    expect(isTradeAction('close')).toBe(false);
    expect(isTradeAction('transfer')).toBe(false);
  });
});
