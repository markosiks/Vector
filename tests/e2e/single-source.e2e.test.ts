import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { explorerTxUrl, isEligible, swrRefreshIntervalMs } from '@/lib/config/derive';

/**
 * End-to-end proof of the single-source-of-truth invariant.
 *
 * Two complementary checks, neither of which mutates the global module registry
 * (so they cannot contaminate other test files):
 *
 *  1. Structural: distinctive constant values appear in `constants.ts` and
 *     **nowhere else** under `lib/` or `app/`. If any consumer had inlined a
 *     literal instead of reading `CONFIG`, this fails.
 *  2. Behavioral: every derived consumer's output equals the value recomputed
 *     straight from `CONFIG`. If a consumer had drifted from the source, this
 *     fails.
 *
 * Together they enforce "change a constant in one file → behavior changes in
 * every consumer", because there is exactly one place to change.
 */

const ROOT = join(import.meta.dir, '..', '..');
const CONFIG_FILE = join('lib', 'config', 'constants.ts');

/** Distinctive literals that must live only in the seeded config. */
const SENTINELS = [
  '1_500', // timing.ui_poll_ms
  '5003', // chain.mantle_testnet_chain_id
  'explorer.sepolia.mantle.xyz', // chain.mantle_explorer_base_url
  'api.nansen.ai', // nansen.endpoint
  'api.elfa.ai', // elfa.endpoint
  'tMNT', // capital.capital_unit_label
] as const;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('single source of truth — structural (no hardcoded duplicates)', () => {
  const files = [...sourceFiles(join(ROOT, 'lib')), ...sourceFiles(join(ROOT, 'app'))];

  test('each sentinel constant lives in constants.ts', () => {
    const config = readFileSync(join(ROOT, CONFIG_FILE), 'utf8');
    for (const sentinel of SENTINELS) {
      expect(config).toContain(sentinel);
    }
  });

  test('no sentinel constant is hardcoded outside constants.ts', () => {
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1);
      if (rel === CONFIG_FILE) continue;
      const text = readFileSync(file, 'utf8');
      for (const sentinel of SENTINELS) {
        expect({ file: rel, sentinel, found: text.includes(sentinel) }).toEqual({
          file: rel,
          sentinel,
          found: false,
        });
      }
    }
  });
});

describe('single source of truth — behavioral (consumers track CONFIG)', () => {
  test('derived values are recomputable purely from CONFIG', () => {
    expect(swrRefreshIntervalMs()).toBe(CONFIG.timing.ui_poll_ms);
    expect(explorerTxUrl('0xabc')).toBe(`${CONFIG.chain.mantle_explorer_base_url}/tx/0xabc`);
  });

  test('the eligibility gate hinges exactly on CONFIG.router.s_min', () => {
    expect(isEligible(CONFIG.router.s_min)).toBe(true);
    expect(isEligible(CONFIG.router.s_min - 0.0001)).toBe(false);
  });
});
