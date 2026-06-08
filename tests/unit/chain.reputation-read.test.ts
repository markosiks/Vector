import { describe, expect, test, mock, beforeEach } from 'bun:test';

import {
  smokeRead,
  getIdentityRegistry,
  readFeedback,
  getSummary,
  REGISTRY_ADDRESS,
  type FeedbackEntry,
  type FeedbackSummary,
} from '@/lib/chain/reputation-read';
import { TESTNET_REPUTATION_REGISTRY, TESTNET_IDENTITY_REGISTRY } from '@/lib/chain/addresses';
import type { PublicClient, Transport, Chain } from 'viem';

/**
 * Mock public client factory.
 * Each test sets up its own readContract mock behavior.
 */
function createMockClient(
  readContractImpl: (...args: any[]) => any = () => {
    throw new Error('readContract not mocked');
  },
) {
  return {
    readContract: mock(readContractImpl),
    getContractEvents: mock(() => []),
  } as unknown as PublicClient<Transport, Chain>;
}

describe('REGISTRY_ADDRESS', () => {
  test('equals the canonical testnet Reputation Registry', () => {
    expect(REGISTRY_ADDRESS).toBe(TESTNET_REPUTATION_REGISTRY);
  });
});

describe('getIdentityRegistry', () => {
  test('calls readContract with correct ABI function', async () => {
    const client = createMockClient(() => TESTNET_IDENTITY_REGISTRY);
    const result = await getIdentityRegistry(client);
    expect(result).toBe(TESTNET_IDENTITY_REGISTRY);
    expect(client.readContract).toHaveBeenCalledTimes(1);
    const call = (client.readContract as any).mock.calls[0][0];
    expect(call.functionName).toBe('getIdentityRegistry');
    expect(call.address).toBe(TESTNET_REPUTATION_REGISTRY);
  });

  test('uses custom registry address when provided', async () => {
    const custom = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as const;
    const client = createMockClient(() => TESTNET_IDENTITY_REGISTRY);
    await getIdentityRegistry(client, custom);
    const call = (client.readContract as any).mock.calls[0][0];
    expect(call.address).toBe(custom);
  });

  test('propagates RPC errors', async () => {
    const client = createMockClient(() => {
      throw new Error('RPC timeout');
    });
    await expect(getIdentityRegistry(client)).rejects.toThrow('RPC timeout');
  });
});

describe('readFeedback', () => {
  test('returns a typed FeedbackEntry', async () => {
    const mockReturn: [bigint, number, string, string, boolean] = [
      100n,
      2,
      'quality',
      'arena-v1',
      false,
    ];
    const client = createMockClient(() => mockReturn);

    const entry = await readFeedback(client, 1n, '0x' + '11'.repeat(20) as any, 1n);
    expect(entry.value).toBe(100n);
    expect(entry.valueDecimals).toBe(2);
    expect(entry.tag1).toBe('quality');
    expect(entry.tag2).toBe('arena-v1');
    expect(entry.isRevoked).toBe(false);
  });

  test('passes correct args to readContract', async () => {
    const client = createMockClient(() => [0n, 0, '', '', false]);
    const agentId = 42n;
    const clientAddr = '0x' + 'ab'.repeat(20) as any;
    const feedbackIdx = 7n;

    await readFeedback(client, agentId, clientAddr, feedbackIdx);
    const call = (client.readContract as any).mock.calls[0][0];
    expect(call.functionName).toBe('readFeedback');
    expect(call.args).toEqual([agentId, clientAddr, feedbackIdx]);
  });

  test('handles revoked feedback', async () => {
    const client = createMockClient(() => [50n, 1, 'perf', '', true]);
    const entry = await readFeedback(client, 1n, '0x' + '11'.repeat(20) as any, 1n);
    expect(entry.isRevoked).toBe(true);
  });

  test('handles negative values (int128)', async () => {
    const client = createMockClient(() => [-500n, 4, 'drawdown', '', false]);
    const entry = await readFeedback(client, 1n, '0x' + '11'.repeat(20) as any, 1n);
    expect(entry.value).toBe(-500n);
  });
});

describe('getSummary', () => {
  test('returns a typed FeedbackSummary with defaults', async () => {
    const mockReturn: [bigint, bigint, number] = [10n, 850n, 2];
    const client = createMockClient(() => mockReturn);

    const summary = await getSummary(client, 1n);
    expect(summary.count).toBe(10n);
    expect(summary.summaryValue).toBe(850n);
    expect(summary.summaryValueDecimals).toBe(2);
  });

  test('passes empty arrays/strings when opts are omitted', async () => {
    const client = createMockClient(() => [0n, 0n, 0]);
    await getSummary(client, 1n);
    const call = (client.readContract as any).mock.calls[0][0];
    expect(call.args[1]).toEqual([]); // clientAddresses
    expect(call.args[2]).toBe('');   // tag1
    expect(call.args[3]).toBe('');   // tag2
  });

  test('passes provided filter options', async () => {
    const client = createMockClient(() => [5n, 400n, 1]);
    const addr = '0x' + 'cc'.repeat(20) as any;
    await getSummary(client, 99n, {
      clientAddresses: [addr],
      tag1: 'quality',
      tag2: 'arena-v1',
    });
    const call = (client.readContract as any).mock.calls[0][0];
    expect(call.args[0]).toBe(99n);
    expect(call.args[1]).toEqual([addr]);
    expect(call.args[2]).toBe('quality');
    expect(call.args[3]).toBe('arena-v1');
  });

  test('handles zero feedback count', async () => {
    const client = createMockClient(() => [0n, 0n, 0]);
    const summary = await getSummary(client, 99n);
    expect(summary.count).toBe(0n);
    expect(summary.summaryValue).toBe(0n);
  });
});

describe('smokeRead', () => {
  test('returns ok:true when registry is reachable', async () => {
    const client = createMockClient(() => TESTNET_IDENTITY_REGISTRY);
    const result = await smokeRead(client);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identityRegistry).toBe(TESTNET_IDENTITY_REGISTRY);
      expect(result.registryAddress).toBe(TESTNET_REPUTATION_REGISTRY);
    }
  });

  test('returns ok:false on RPC error (does not throw)', async () => {
    const client = createMockClient(() => {
      throw new Error('connection refused');
    });
    const result = await smokeRead(client);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('connection refused');
      expect(result.registryAddress).toBe(TESTNET_REPUTATION_REGISTRY);
    }
  });

  test('returns ok:false on non-Error throw', async () => {
    const client = createMockClient(() => {
      throw 'string error';
    });
    const result = await smokeRead(client);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('string error');
    }
  });

  test('uses custom registry address', async () => {
    const custom = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
    const client = createMockClient(() => TESTNET_IDENTITY_REGISTRY);
    const result = await smokeRead(client, custom);
    expect(result.registryAddress).toBe(custom);
  });
});
