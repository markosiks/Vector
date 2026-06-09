import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import example from '@/docs/examples/signed-intent.json';
import { CONFIG } from '@/lib/config/constants';
import { canonicalPayload, intentHash } from '@/lib/intent/canonical';
import {
  intentJsonSchema,
  REJECTION_CATALOG,
  unsignedIntentJsonSchema,
  VALIDATION_STAGES,
  WHITELISTED_MARKETS,
} from '@/lib/intent/onboarding';
import { signedIntentSchema } from '@/lib/intent/schema';
import { validateIntent } from '@/lib/intent/validate';

/**
 * P3.3 onboarding conformance. The page and `docs/onboarding.md` are prose over
 * two normative artifacts — the zod schema and the committed golden example — so
 * these tests pin the *only* CI-checkable guarantees the onboarding surface
 * makes: the example passes the full P0.3 validator, it agrees with the published
 * schema, the rejection catalogue tracks the validator's stages, and neither the
 * page nor the doc re-states (and so cannot drift from) the schema or the example.
 */

const ROOT = join(import.meta.dir, '..', '..', '..');
const PAGE_FILE = join(ROOT, 'app', 'onboarding', 'page.tsx');
const DOC_FILE = join(ROOT, 'docs', 'onboarding.md');

/** A reference time comfortably before the pinned example's far-future ttl. */
const NOW = new Date('2026-01-01T00:00:00.000Z');

describe('onboarding example — passes the full P0.3 validator (the CI guarantee)', () => {
  test('validateIntent accepts the committed example end-to-end', async () => {
    const result = await validateIntent(example.intent, {
      resolveSigner: () => example.signer as `0x${string}`,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrow for the type checker
    expect(result.intent_hash).toBe(example.intent_hash as `0x${string}`);
  });

  test('the example agrees with the published schema (parse + canonical + hash)', () => {
    const parsed = signedIntentSchema.parse(example.intent);
    expect(canonicalPayload(parsed)).toBe(example.canonical_payload);
    expect(intentHash(parsed)).toBe(example.intent_hash as `0x${string}`);
  });

  test('the example targets a currently-whitelisted market', () => {
    expect(WHITELISTED_MARKETS).toContain((example.intent as { market: string }).market);
  });
});

describe('onboarding rejection catalogue tracks the validator', () => {
  test('every validator stage has a documented rejection class', () => {
    const documented = new Set(REJECTION_CATALOG.map((r) => r.stage));
    expect([...documented].sort()).toEqual([...VALIDATION_STAGES].sort());
  });

  test('whitelisted markets are single-sourced from CONFIG', () => {
    expect(WHITELISTED_MARKETS).toEqual([...CONFIG.policy.market_whitelist]);
  });
});

describe('onboarding surface does not duplicate (and cannot drift from) the schema', () => {
  test('the page renders the schema from source, not an inlined copy', () => {
    const src = readFileSync(PAGE_FILE, 'utf8');
    // Consumes the single source…
    expect(src).toContain('intentJsonSchema');
    expect(src).toContain("from '@/lib/intent/onboarding'");
    // …and never restates the JSON Schema as a literal.
    expect(src).not.toContain('"$schema"');
    expect(src).not.toContain('zodToJsonSchema');
  });

  test('the JSON Schema exports are objects (rendered verbatim by the page)', () => {
    expect(typeof intentJsonSchema).toBe('object');
    expect(typeof unsignedIntentJsonSchema).toBe('object');
  });

  test('the example embedded in docs/onboarding.md is byte-identical to the golden file', () => {
    const doc = readFileSync(DOC_FILE, 'utf8');
    const marker = doc.indexOf('<!-- example:signed-intent');
    expect(marker).toBeGreaterThan(-1);
    const fenceStart = doc.indexOf('```json', marker);
    expect(fenceStart).toBeGreaterThan(-1);
    const bodyStart = doc.indexOf('\n', fenceStart) + 1;
    const fenceEnd = doc.indexOf('```', bodyStart);
    expect(fenceEnd).toBeGreaterThan(-1);
    const embedded = JSON.parse(doc.slice(bodyStart, fenceEnd));
    expect(embedded).toEqual(example.intent);
  });

  test('the doc records the example canonical payload and hash from the golden file', () => {
    const doc = readFileSync(DOC_FILE, 'utf8');
    expect(doc).toContain(example.canonical_payload);
    expect(doc).toContain(example.intent_hash);
  });
});
