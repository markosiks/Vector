import { describe, expect, test } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';

import { verifyAuthorization, verifyEip191Authorization } from '@/lib/chain/auth';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const account = privateKeyToAccount(KEY);
const OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;

describe('verifyEip191Authorization', () => {
  test('accepts a signature made by the expected signer', async () => {
    const message = 'vector-feedback:agent=1:round=3';
    const signature = await account.signMessage({ message });
    expect(await verifyEip191Authorization(message, signature, account.address)).toBe(true);
  });

  test('is checksum-insensitive on the expected signer', async () => {
    const message = 'msg';
    const signature = await account.signMessage({ message });
    expect(await verifyEip191Authorization(message, signature, account.address.toLowerCase())).toBe(
      true,
    );
  });

  test('rejects a signature from a different signer', async () => {
    const message = 'msg';
    const signature = await account.signMessage({ message });
    expect(await verifyEip191Authorization(message, signature, OTHER)).toBe(false);
  });

  test('rejects a tampered message', async () => {
    const signature = await account.signMessage({ message: 'original' });
    expect(await verifyEip191Authorization('tampered', signature, account.address)).toBe(false);
  });

  test('returns false (never throws) on a malformed signature', async () => {
    expect(await verifyEip191Authorization('m', '0xdeadbeef' as Hex, account.address)).toBe(false);
  });

  test('returns false on a malformed expected address', async () => {
    const signature = await account.signMessage({ message: 'm' });
    expect(await verifyEip191Authorization('m', signature, 'not-an-address')).toBe(false);
  });
});

describe('verifyAuthorization (EOA + ERC-1271 via client)', () => {
  test('delegates the verdict to the client verifier', async () => {
    const verifier = { verifyMessage: async () => true };
    expect(await verifyAuthorization(verifier, 'm', '0x00' as Hex, account.address)).toBe(true);
  });

  test('returns false when the verifier rejects', async () => {
    const verifier = { verifyMessage: async () => false };
    expect(await verifyAuthorization(verifier, 'm', '0x00' as Hex, account.address)).toBe(false);
  });

  test('returns false (never throws) when the verifier throws', async () => {
    const verifier = {
      verifyMessage: async () => {
        throw new Error('rpc down');
      },
    };
    expect(await verifyAuthorization(verifier, 'm', '0x00' as Hex, account.address)).toBe(false);
  });

  test('returns false on a malformed expected address without calling the client', async () => {
    let called = false;
    const verifier = {
      verifyMessage: async () => {
        called = true;
        return true;
      },
    };
    expect(await verifyAuthorization(verifier, 'm', '0x00' as Hex, 'bad')).toBe(false);
    expect(called).toBe(false);
  });
});
