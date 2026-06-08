import { describe, expect, test } from 'bun:test';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';

import { identityRegistryAbi } from '@/lib/chain/abi';
import {
  agentExists,
  assertCanAttest,
  IdentityError,
  registerAgent,
  type IdentityReader,
  type IdentityWriteClient,
  type RegisterReceipt,
} from '@/lib/chain/identity';

const IDENTITY = '0x8004A818BFB912233c491871b3d84c89A494BD9e' as Address;
const OWNER = '0x3D7532C757267e823Eeb6005CC081764081811cb' as Address;
const ATTESTOR = '0x1111111111111111111111111111111111111111' as Address;

/** A reader stub: `owners` maps an id to its owner; absent → unregistered. */
function fakeReader(owners: Record<string, Address>): IdentityReader {
  return {
    ownerOf: async (agentId) => owners[agentId.toString()] ?? null,
    isAuthorizedOrOwner: async (spender, agentId) =>
      owners[agentId.toString()] !== undefined && owners[agentId.toString()] === spender,
  };
}

describe('agentExists', () => {
  test('true for a registered token, false for an unregistered one', async () => {
    const reader = fakeReader({ '1': OWNER });
    expect(await agentExists(reader, 1n)).toBe(true);
    expect(await agentExists(reader, 2n)).toBe(false);
  });

  test('rejects an out-of-range id before any read', async () => {
    const reader = fakeReader({});
    await expect(agentExists(reader, (1n << 256n) + 1n)).rejects.toBeInstanceOf(IdentityError);
  });
});

describe('assertCanAttest (two-key guard)', () => {
  test('passes when a distinct attestor attests a registered agent', async () => {
    const reader = fakeReader({ '1': OWNER });
    await expect(assertCanAttest(reader, ATTESTOR, 1n)).resolves.toBeUndefined();
  });

  test('rejects when the agent is not registered', async () => {
    const reader = fakeReader({});
    await expect(assertCanAttest(reader, ATTESTOR, 1n)).rejects.toThrow(/not registered/);
  });

  test('rejects self-feedback (attestor is the owner/operator)', async () => {
    const reader = fakeReader({ '1': OWNER });
    await expect(assertCanAttest(reader, OWNER, 1n)).rejects.toThrow(/self-feedback/i);
  });
});

/** Build a confirmed receipt carrying a real `Registered` log for `agentId`. */
function receiptWith(agentId: bigint, emitter: Address): RegisterReceipt {
  const topics = encodeEventTopics({
    abi: identityRegistryAbi,
    eventName: 'Registered',
    args: { agentId, owner: OWNER },
  }) as Hex[];
  const data = encodeAbiParameters([{ type: 'string' }], ['ipfs://card']);
  return {
    status: 'success',
    logs: [{ address: emitter, topics, data }],
  };
}

function fakeWriter(receipt: RegisterReceipt): IdentityWriteClient {
  return {
    writeRegister: async () => ('0x' + 'ab'.repeat(32)) as Hex,
    waitForReceipt: async () => receipt,
  };
}

describe('registerAgent', () => {
  test('returns the minted tokenId decoded from the Registered event', async () => {
    const agentId = await registerAgent(fakeWriter(receiptWith(7n, IDENTITY)), IDENTITY, 'ipfs://card');
    expect(agentId).toBe(7n);
  });

  test('ignores Registered logs emitted by a different address', async () => {
    const stray = receiptWith(7n, '0x9999999999999999999999999999999999999999' as Address);
    await expect(registerAgent(fakeWriter(stray), IDENTITY, 'ipfs://card')).rejects.toThrow(
      /no decodable Registered/,
    );
  });

  test('throws on a reverted transaction', async () => {
    const reverted: RegisterReceipt = { status: 'reverted', logs: [] };
    await expect(registerAgent(fakeWriter(reverted), IDENTITY, 'ipfs://card')).rejects.toThrow(
      /reverted/,
    );
  });

  test('throws when the receipt has no Registered event', async () => {
    const empty: RegisterReceipt = { status: 'success', logs: [] };
    await expect(registerAgent(fakeWriter(empty), IDENTITY, 'ipfs://card')).rejects.toThrow(
      /no decodable Registered/,
    );
  });

  test('rejects an over-long agentURI before sending a transaction', async () => {
    let sent = false;
    const writer: IdentityWriteClient = {
      writeRegister: async () => {
        sent = true;
        return '0x' as Hex;
      },
      waitForReceipt: async () => ({ status: 'success', logs: [] }),
    };
    await expect(registerAgent(writer, IDENTITY, 'x'.repeat(3000))).rejects.toBeInstanceOf(
      IdentityError,
    );
    expect(sent).toBe(false);
  });
});
