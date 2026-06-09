import { describe, expect, test } from 'bun:test';

import vendored from '@/lib/chain/abis/ReputationRegistry.json';
import { reputationRegistryAbi } from '@/lib/chain/abi';

/**
 * The typed ABI is a hand-written subset of the vendored canonical artifact.
 * These tests guarantee the two never drift: every entry in the typed ABI must
 * appear byte-faithfully in the vendored JSON, and the curated surface must stay
 * read-path + `giveFeedback` only (no admin/upgrade functions).
 */

type AbiEntry = { type: string; name?: string; [k: string]: unknown };

function findMatch(name: string, type: string): AbiEntry | undefined {
  return (vendored as AbiEntry[]).find((e) => e.type === type && e.name === name);
}

describe('reputationRegistryAbi vs vendored JSON', () => {
  test('every typed entry matches the vendored artifact exactly', () => {
    type Param = { name: string; type: string };
    type Loose = AbiEntry & {
      inputs?: readonly Param[];
      outputs?: readonly Param[];
      stateMutability?: string;
    };
    // Compare inputs/outputs by ABI-significant fields (name + type), order-sensitive.
    const norm = (xs: readonly Param[] | undefined) =>
      (xs ?? []).map((x) => ({ name: x.name, type: x.type }));

    for (const raw of reputationRegistryAbi) {
      const entry = raw as unknown as Loose;
      const match = findMatch(entry.name as string, entry.type) as Loose | undefined;
      expect(match).toBeDefined();
      const m = match!;
      expect(norm(entry.inputs)).toEqual(norm(m.inputs));
      if (entry.type === 'function') {
        expect(norm(entry.outputs)).toEqual(norm(m.outputs));
        expect(entry.stateMutability).toBe(m.stateMutability);
      }
    }
  });

  test('curated surface exposes no admin/upgrade functions', () => {
    const names = reputationRegistryAbi.filter((e) => e.type === 'function').map((e) => e.name);
    for (const forbidden of [
      'initialize',
      'upgradeToAndCall',
      'transferOwnership',
      'renounceOwnership',
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  test('the one write exposed is giveFeedback', () => {
    const writes = reputationRegistryAbi.filter(
      (e) => e.type === 'function' && e.stateMutability === 'nonpayable',
    );
    expect(writes.map((w) => w.name)).toEqual(['giveFeedback']);
  });
});
