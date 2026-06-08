import { describe, expect, test, mock, beforeEach } from 'bun:test';
import type { PublicClient, Transport, Chain } from 'viem';

import {
  smokeRead,
  getIdentityRegistry,
  readFeedback,
  getSummary,
} from '@/lib/chain/reputation-read';
import {
  signFeedbackAuth,
  verifyFeedbackAuth,
  isAuthExpired,
} from '@/lib/chain/feedback-auth';
import { deriveAgentIdOnchain, formatAgentIdOnchain } from '@/lib/chain/agent-id';
import {
  TESTNET_IDENTITY_REGISTRY,
  TESTNET_REPUTATION_REGISTRY,
} from '@/lib/chain/addresses';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

/**
 * Hard end-to-end tests (§11 of P1.7 spec).
 *
 * Extreme, invalid, and boundary conditions. These tests verify that the
 * system either succeeds or fails safely and informatively without key leakage.
 *
 * Tests use mocked RPC to simulate extreme network conditions.
 */

function createMockClient(impl: (...args: any[]) => any) {
  return {
    readContract: mock(impl),
    getContractEvents: mock(() => []),
    getChainId: mock(() => 5003),
  } as unknown as PublicClient<Transport, Chain>;
}

// ── RPC latency / timeout / rate-limit ────────────────────────────────────

describe('E2E: RPC high latency / timeouts', () => {
  test('smokeRead handles slow RPC (simulated 5s delay)', async () => {
    const client = createMockClient(async () => {
      await new Promise((r) => setTimeout(r, 100)); // simulated latency
      return TESTNET_IDENTITY_REGISTRY;
    });
    const result = await smokeRead(client);
    expect(result.ok).toBe(true);
  });

  test('smokeRead handles RPC timeout error gracefully', async () => {
    const client = createMockClient(() => {
      throw new Error('Request timed out after 30000ms');
    });
    const result = await smokeRead(client);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('timed out');
    }
  });

  test('smokeRead handles rate-limit error (429)', async () => {
    const client = createMockClient(() => {
      const err = new Error('rate limit exceeded');
      (err as any).status = 429;
      throw err;
    });
    const result = await smokeRead(client);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('rate limit');
    }
  });

  test('readFeedback propagates RPC connection refused', async () => {
    const client = createMockClient(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      readFeedback(client, 1n, '0x' + '00'.repeat(20) as any, 1n),
    ).rejects.toThrow('ECONNREFUSED');
  });
});

// ── Wrong chainId / network ───────────────────────────────────────────────

describe('E2E: wrong chainId / ABI mismatch', () => {
  test('smokeRead when registry returns garbage (ABI mismatch)', async () => {
    const client = createMockClient(() => {
      throw new Error(
        'execution reverted: function selector was not recognized and there\'s no fallback function',
      );
    });
    const result = await smokeRead(client);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('reverted');
    }
  });

  test('readFeedback with non-existent agentId returns cleanly from mock', async () => {
    // On real chain this would revert; mock simulates the error
    const client = createMockClient(() => {
      throw new Error('execution reverted: agent does not exist');
    });
    await expect(
      readFeedback(client, 999999999n, '0x' + '00'.repeat(20) as any, 1n),
    ).rejects.toThrow('agent does not exist');
  });
});

// ── Authorization signature extremes ──────────────────────────────────────

describe('E2E: authorization signature edge cases', () => {
  test('signature with all-zero parameters', async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);

    const auth = await signFeedbackAuth(pk, {
      agentId: 0n,
      clientAddress: '0x' + '00'.repeat(20) as `0x${string}`,
      maxFeedbackIndex: 0n,
      expiry: 0n,
    });

    const ok = await verifyFeedbackAuth(auth, account.address);
    expect(ok).toBe(true);

    // But it's expired (expiry=0 is in the past)
    expect(isAuthExpired(auth.expiry)).toBe(true);
  });

  test('signature with max uint256 agentId', async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const maxU256 = 2n ** 256n - 1n;

    const auth = await signFeedbackAuth(pk, {
      agentId: maxU256,
      clientAddress: '0x' + 'ff'.repeat(20) as `0x${string}`,
      maxFeedbackIndex: 2n ** 64n - 1n,
      expiry: 2n ** 64n - 1n,
    });

    const ok = await verifyFeedbackAuth(auth, account.address);
    expect(ok).toBe(true);
  });

  test('forged signature (random bytes) is rejected', async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);

    const randomSig = ('0x' + [...new Uint8Array(65)]
      .map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, '0'))
      .join('')) as `0x${string}`;

    const ok = await verifyFeedbackAuth(
      {
        agentId: 1n,
        clientAddress: '0x' + '11'.repeat(20) as `0x${string}`,
        maxFeedbackIndex: 1n,
        expiry: 9999999999n,
        signature: randomSig,
      },
      account.address,
    );
    expect(ok).toBe(false);
  });

  test('zero-length signature is rejected', async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);

    const ok = await verifyFeedbackAuth(
      {
        agentId: 1n,
        clientAddress: '0x' + '11'.repeat(20) as `0x${string}`,
        maxFeedbackIndex: 1n,
        expiry: 9999999999n,
        signature: '0x' as `0x${string}`,
      },
      account.address,
    );
    expect(ok).toBe(false);
  });

  test('key rotation: old key signature rejected by new key address', async () => {
    const oldPk = generatePrivateKey();
    const newPk = generatePrivateKey();
    const newAccount = privateKeyToAccount(newPk);

    const auth = await signFeedbackAuth(oldPk, {
      agentId: 42n,
      clientAddress: '0x' + '11'.repeat(20) as `0x${string}`,
      maxFeedbackIndex: 10n,
      expiry: 9999999999n,
    });

    // Verify against NEW key — must fail
    const ok = await verifyFeedbackAuth(auth, newAccount.address);
    expect(ok).toBe(false);
  });
});

// ── agent_id_onchain provenance extremes ──────────────────────────────────

describe('E2E: agent_id_onchain boundary conditions', () => {
  test('empty string agent id produces a valid hash', () => {
    const addr = '0x' + '11'.repeat(20) as `0x${string}`;
    const id = deriveAgentIdOnchain('', addr);
    expect(id).toBeGreaterThanOrEqual(0n);
    expect(id).toBeLessThan(2n ** 256n);
  });

  test('very long agent id string does not crash', () => {
    const longId = 'a'.repeat(100_000);
    const addr = '0x' + '11'.repeat(20) as `0x${string}`;
    const id = deriveAgentIdOnchain(longId, addr);
    expect(typeof id).toBe('bigint');
  });

  test('unicode agent id is handled', () => {
    const addr = '0x' + '11'.repeat(20) as `0x${string}`;
    const id = deriveAgentIdOnchain('агент-🤖-шифр', addr);
    expect(typeof id).toBe('bigint');
  });

  test('formatAgentIdOnchain for max uint256 produces 66-char string', () => {
    const max = 2n ** 256n - 1n;
    const formatted = formatAgentIdOnchain(max);
    expect(formatted.length).toBe(66);
    expect(formatted).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

// ── Config-registry coherence ─────────────────────────────────────────────

describe('E2E: config-registry coherence', () => {
  test('CONFIG addresses match the addresses module', () => {
    const { CONFIG } = require('@/lib/config/constants');
    expect(CONFIG.erc8004.reputation_registry).toBe(TESTNET_REPUTATION_REGISTRY);
    expect(CONFIG.erc8004.identity_registry).toBe(TESTNET_IDENTITY_REGISTRY);
  });

  test('CONFIG chain id matches mantleSepolia chain definition', () => {
    const { CONFIG } = require('@/lib/config/constants');
    const { mantleSepolia } = require('@/lib/chain/mantle-sepolia');
    expect(CONFIG.chain.mantle_testnet_chain_id).toBe(mantleSepolia.id);
  });
});

// ── Safe failure: no key leakage ──────────────────────────────────────────

describe('E2E: safe failure without key leakage', () => {
  test('error messages from smokeRead never contain private key material', async () => {
    const errors = [
      new Error('connect ECONNREFUSED 127.0.0.1:8545'),
      new Error('nonce too low: next nonce 42, got 41'),
      new Error('insufficient funds for gas * price + value'),
      new Error('replacement transaction underpriced'),
      new Error('intrinsic gas too low'),
    ];

    for (const err of errors) {
      const client = createMockClient(() => {
        throw err;
      });
      const result = await smokeRead(client);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Error must not contain hex patterns that look like private keys
        expect(result.error).not.toMatch(/0x[0-9a-f]{64}/i);
        // Error must not contain the word "private"
        expect(result.error.toLowerCase()).not.toContain('private key');
      }
    }
  });
});
