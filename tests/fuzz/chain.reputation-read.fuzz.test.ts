import { describe, expect, test, mock } from 'bun:test';

import {
  smokeRead,
  readFeedback,
  getSummary,
} from '@/lib/chain/reputation-read';
import type { PublicClient, Transport, Chain } from 'viem';

/**
 * Fuzz tests for reputation-read: randomized/adversarial RPC response shapes.
 *
 * These tests verify that the read helpers handle malformed, unexpected, or
 * extreme RPC responses without crashing or leaking internal state.
 */

function createMockClient(readContractImpl: (...args: any[]) => any) {
  return {
    readContract: mock(readContractImpl),
    getContractEvents: mock(() => []),
  } as unknown as PublicClient<Transport, Chain>;
}

const FUZZ_ROUNDS = 20;

describe('smokeRead fuzz — adversarial RPC responses', () => {
  test('survives random error types', async () => {
    const errorThings: unknown[] = [
      new Error('timeout'),
      new Error(''),
      new TypeError('null is not an object'),
      new RangeError('maximum call stack'),
      'string error',
      42,
      null,
      undefined,
      { code: -32000, message: 'execution reverted' },
      new Error('revert 0x12345678'),
    ];

    for (const thing of errorThings) {
      const client = createMockClient(() => {
        throw thing;
      });
      const result = await smokeRead(client);
      expect(result.ok).toBe(false);
      // Should never throw — always returns structured failure.
    }
  });

  test('survives returning non-address values', async () => {
    const badReturns = [0, '', null, undefined, 42n, true, [], {}];
    for (const bad of badReturns) {
      const client = createMockClient(() => bad);
      // getIdentityRegistry returns whatever the mock gives — smokeRead wraps it
      const result = await smokeRead(client);
      // As long as it didn't throw, the test passes.
      expect(result).toBeDefined();
    }
  });
});

describe('readFeedback fuzz — adversarial return tuples', () => {
  test('handles extreme int128 values', async () => {
    const maxI128 = (2n ** 127n) - 1n;
    const minI128 = -(2n ** 127n);

    for (const val of [maxI128, minI128, 0n, 1n, -1n]) {
      const client = createMockClient(() => [val, 18, '', '', false]);
      const entry = await readFeedback(client, 1n, '0x' + '00'.repeat(20) as any, 1n);
      expect(entry.value).toBe(val);
    }
  });

  test('handles all valid valueDecimals 0–18', async () => {
    for (let d = 0; d <= 18; d++) {
      const client = createMockClient(() => [100n, d, 'tag', '', false]);
      const entry = await readFeedback(client, 1n, '0x' + '00'.repeat(20) as any, 1n);
      expect(entry.valueDecimals).toBe(d);
    }
  });

  test('handles very long tag strings', async () => {
    const longTag = 'x'.repeat(10_000);
    const client = createMockClient(() => [100n, 2, longTag, longTag, false]);
    const entry = await readFeedback(client, 1n, '0x' + '00'.repeat(20) as any, 1n);
    expect(entry.tag1.length).toBe(10_000);
    expect(entry.tag2.length).toBe(10_000);
  });

  test('handles empty tags', async () => {
    const client = createMockClient(() => [100n, 2, '', '', false]);
    const entry = await readFeedback(client, 1n, '0x' + '00'.repeat(20) as any, 1n);
    expect(entry.tag1).toBe('');
    expect(entry.tag2).toBe('');
  });

  test('handles unicode in tags', async () => {
    const unicode = '🤖🔗评分αβγ';
    const client = createMockClient(() => [100n, 2, unicode, unicode, false]);
    const entry = await readFeedback(client, 1n, '0x' + '00'.repeat(20) as any, 1n);
    expect(entry.tag1).toBe(unicode);
  });
});

describe('getSummary fuzz — edge-case return values', () => {
  test('handles count=0 with non-zero value (weird but possible)', async () => {
    const client = createMockClient(() => [0n, 999n, 5]);
    const summary = await getSummary(client, 1n);
    expect(summary.count).toBe(0n);
    expect(summary.summaryValue).toBe(999n);
  });

  test('handles very large counts', async () => {
    const large = 2n ** 63n - 1n;
    const client = createMockClient(() => [large, 0n, 0]);
    const summary = await getSummary(client, 1n);
    expect(summary.count).toBe(large);
  });

  test('handles negative summaryValue', async () => {
    const client = createMockClient(() => [10n, -(2n ** 100n), 8]);
    const summary = await getSummary(client, 1n);
    expect(summary.summaryValue).toBeLessThan(0n);
  });

  test('handles random agentIds without crashing', async () => {
    for (let i = 0; i < FUZZ_ROUNDS; i++) {
      const arr = new Uint8Array(32);
      crypto.getRandomValues(arr);
      const agentId = BigInt('0x' + [...arr].map((b) => b.toString(16).padStart(2, '0')).join(''));

      const client = createMockClient(() => [0n, 0n, 0]);
      const summary = await getSummary(client, agentId);
      expect(summary).toBeDefined();
    }
  });
});
