import { describe, expect, test } from 'bun:test';
import type { Address, Hex } from 'viem';

import {
  RegistryError,
  assertDeployed,
  getAgentSummary,
  getClients,
  getIdentityRegistry,
  getLastIndex,
  getVersion,
  readFeedback,
  smokeRead,
  type RegistryReadFn,
  type ReputationReader,
} from '@/lib/chain/registry';

const REG = '0x8004B663056A597Dffe9eCcC1965A193B7388713' as Address;
const ID = '0x8004A818BFB912233c491871b3d84c89A494BD9e' as Address;

/** A scripted reader: each read function returns a fixed value or throws. */
function reader(overrides: {
  code?: Hex | undefined;
  reads?: Partial<Record<RegistryReadFn, unknown | (() => unknown)>>;
}): ReputationReader {
  return {
    getCode: async () => overrides.code,
    readContract: async (fn: RegistryReadFn) => {
      const v = overrides.reads?.[fn];
      return typeof v === 'function' ? (v as () => unknown)() : v;
    },
  };
}

describe('assertDeployed', () => {
  test('passes when bytecode is present', async () => {
    await expect(assertDeployed(reader({ code: '0x60806040' }), REG)).resolves.toBeUndefined();
  });

  test('rejects empty bytecode', async () => {
    await expect(assertDeployed(reader({ code: '0x' }), REG)).rejects.toBeInstanceOf(RegistryError);
  });

  test('rejects an undefined (no-contract) response', async () => {
    await expect(assertDeployed(reader({ code: undefined }), REG)).rejects.toBeInstanceOf(
      RegistryError,
    );
  });
});

describe('smokeRead', () => {
  test('returns the identity registry and version on a live contract', async () => {
    const r = reader({
      code: '0x1234',
      reads: { getIdentityRegistry: ID, getVersion: '2.0.0' },
    });
    expect(await smokeRead(r, REG)).toEqual({
      address: REG,
      deployed: true,
      identityRegistry: ID,
      version: '2.0.0',
    });
  });

  test('fails closed when the contract is absent', async () => {
    const r = reader({ code: '0x', reads: { getIdentityRegistry: ID, getVersion: '2.0.0' } });
    await expect(smokeRead(r, REG)).rejects.toBeInstanceOf(RegistryError);
  });
});

describe('getIdentityRegistry / getVersion output validation', () => {
  test('rejects a non-address identity result', async () => {
    await expect(
      getIdentityRegistry(reader({ reads: { getIdentityRegistry: 42 } })),
    ).rejects.toBeInstanceOf(RegistryError);
  });

  test('rejects a non-string version result', async () => {
    await expect(getVersion(reader({ reads: { getVersion: 123 } }))).rejects.toBeInstanceOf(
      RegistryError,
    );
  });

  test('checksums a lowercase identity address', async () => {
    const r = reader({ reads: { getIdentityRegistry: ID.toLowerCase() } });
    expect(await getIdentityRegistry(r)).toBe(ID);
  });
});

describe('input validation before the RPC', () => {
  const r = reader({ reads: { getLastIndex: 0n, getSummary: [0n, 0n, 0], readFeedback: [0n, 0, '', '', false] } });

  test('rejects a negative agentId', async () => {
    await expect(getLastIndex(r, -1, ID)).rejects.toBeInstanceOf(RegistryError);
  });

  test('rejects an agentId above uint256', async () => {
    await expect(getLastIndex(r, (1n << 256n).toString(), ID)).rejects.toBeInstanceOf(RegistryError);
  });

  test('rejects a malformed client address', async () => {
    await expect(getLastIndex(r, 1, 'not-an-address')).rejects.toBeInstanceOf(RegistryError);
  });

  test('rejects a non-integer agentId', async () => {
    await expect(readFeedback(r, '1.5', ID, 0)).rejects.toBeInstanceOf(RegistryError);
  });

  test('rejects a feedback index above uint64', async () => {
    await expect(readFeedback(r, 1, ID, (1n << 64n).toString())).rejects.toBeInstanceOf(
      RegistryError,
    );
  });

  test('rejects one bad address inside a clients[] filter', async () => {
    await expect(getAgentSummary(r, 1, [ID, 'bad'])).rejects.toBeInstanceOf(RegistryError);
  });
});

describe('output shape validation', () => {
  test('getAgentSummary decodes a well-formed tuple', async () => {
    const r = reader({ reads: { getSummary: [3n, -1500n, 2] } });
    expect(await getAgentSummary(r, 1, [ID])).toEqual({ count: 3n, value: -1500n, valueDecimals: 2 });
  });

  test('getAgentSummary rejects an empty clients set before the RPC (no "all" sentinel)', async () => {
    const r = reader({ reads: { getSummary: [3n, 0n, 0] } });
    await expect(getAgentSummary(r, 1, [])).rejects.toBeInstanceOf(RegistryError);
  });

  test('getAgentSummary rejects a short tuple', async () => {
    const r = reader({ reads: { getSummary: [3n] } });
    await expect(getAgentSummary(r, 1, [ID])).rejects.toBeInstanceOf(RegistryError);
  });

  test('getClients decodes an address list', async () => {
    const r = reader({ reads: { getClients: [ID.toLowerCase()] } });
    expect(await getClients(r, 1)).toEqual([ID]);
  });

  test('getClients rejects a non-array result', async () => {
    const r = reader({ reads: { getClients: 'nope' } });
    await expect(getClients(r, 1)).rejects.toBeInstanceOf(RegistryError);
  });

  test('readFeedback decodes a full record', async () => {
    const r = reader({ reads: { readFeedback: [100n, 0, 'quality', '', false] } });
    expect(await readFeedback(r, 1, ID, 0)).toEqual({
      value: 100n,
      valueDecimals: 0,
      tag1: 'quality',
      tag2: '',
      isRevoked: false,
    });
  });

  test('readFeedback rejects a malformed tuple', async () => {
    const r = reader({ reads: { readFeedback: 'nope' } });
    await expect(readFeedback(r, 1, ID, 0)).rejects.toBeInstanceOf(RegistryError);
  });
});
