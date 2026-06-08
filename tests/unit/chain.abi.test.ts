import { describe, expect, test } from 'bun:test';

import { REPUTATION_REGISTRY_ABI } from '@/lib/chain/abi/reputation-registry';

describe('ReputationRegistry ABI', () => {
  test('ABI is a non-empty array', () => {
    expect(Array.isArray(REPUTATION_REGISTRY_ABI)).toBe(true);
    expect(REPUTATION_REGISTRY_ABI.length).toBeGreaterThan(0);
  });

  test('contains getIdentityRegistry view function', () => {
    const fn = REPUTATION_REGISTRY_ABI.find(
      (e) => e.type === 'function' && e.name === 'getIdentityRegistry',
    );
    expect(fn).toBeDefined();
    expect(fn!.type).toBe('function');
    expect((fn as any).stateMutability).toBe('view');
    expect((fn as any).inputs).toHaveLength(0);
    expect((fn as any).outputs).toHaveLength(1);
    expect((fn as any).outputs[0].type).toBe('address');
  });

  test('contains giveFeedback nonpayable function', () => {
    const fn = REPUTATION_REGISTRY_ABI.find(
      (e) => e.type === 'function' && e.name === 'giveFeedback',
    );
    expect(fn).toBeDefined();
    expect((fn as any).stateMutability).toBe('nonpayable');
    expect((fn as any).inputs).toHaveLength(8);
    // Check first input is agentId uint256
    expect((fn as any).inputs[0].name).toBe('agentId');
    expect((fn as any).inputs[0].type).toBe('uint256');
    // Check value is int128
    expect((fn as any).inputs[1].name).toBe('value');
    expect((fn as any).inputs[1].type).toBe('int128');
    // Check valueDecimals is uint8
    expect((fn as any).inputs[2].name).toBe('valueDecimals');
    expect((fn as any).inputs[2].type).toBe('uint8');
  });

  test('contains readFeedback view function', () => {
    const fn = REPUTATION_REGISTRY_ABI.find(
      (e) => e.type === 'function' && e.name === 'readFeedback',
    );
    expect(fn).toBeDefined();
    expect((fn as any).stateMutability).toBe('view');
    expect((fn as any).inputs).toHaveLength(3);
    expect((fn as any).outputs).toHaveLength(5);
  });

  test('contains getSummary view function', () => {
    const fn = REPUTATION_REGISTRY_ABI.find(
      (e) => e.type === 'function' && e.name === 'getSummary',
    );
    expect(fn).toBeDefined();
    expect((fn as any).stateMutability).toBe('view');
    expect((fn as any).outputs).toHaveLength(3);
  });

  test('contains readAllFeedback view function', () => {
    const fn = REPUTATION_REGISTRY_ABI.find(
      (e) => e.type === 'function' && e.name === 'readAllFeedback',
    );
    expect(fn).toBeDefined();
    expect((fn as any).stateMutability).toBe('view');
    expect((fn as any).inputs).toHaveLength(5);
    expect((fn as any).outputs).toHaveLength(7);
  });

  test('contains revokeFeedback function', () => {
    const fn = REPUTATION_REGISTRY_ABI.find(
      (e) => e.type === 'function' && e.name === 'revokeFeedback',
    );
    expect(fn).toBeDefined();
    expect((fn as any).stateMutability).toBe('nonpayable');
  });

  test('contains NewFeedback event', () => {
    const ev = REPUTATION_REGISTRY_ABI.find(
      (e) => e.type === 'event' && e.name === 'NewFeedback',
    );
    expect(ev).toBeDefined();
    expect((ev as any).inputs.length).toBeGreaterThanOrEqual(10);
    // Check indexed fields
    const indexed = (ev as any).inputs.filter((i: any) => i.indexed);
    expect(indexed.length).toBe(3); // agentId, clientAddress, indexedTag1
  });

  test('contains FeedbackRevoked event', () => {
    const ev = REPUTATION_REGISTRY_ABI.find(
      (e) => e.type === 'event' && e.name === 'FeedbackRevoked',
    );
    expect(ev).toBeDefined();
  });

  test('all function entries have required fields', () => {
    for (const entry of REPUTATION_REGISTRY_ABI) {
      if (entry.type === 'function') {
        expect(entry).toHaveProperty('name');
        expect(entry).toHaveProperty('inputs');
        expect(entry).toHaveProperty('outputs');
        expect(entry).toHaveProperty('stateMutability');
      }
    }
  });

  test('all event entries have required fields', () => {
    for (const entry of REPUTATION_REGISTRY_ABI) {
      if (entry.type === 'event') {
        expect(entry).toHaveProperty('name');
        expect(entry).toHaveProperty('inputs');
      }
    }
  });
});
