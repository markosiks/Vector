import { z } from 'zod';

/**
 * The Byreal CLI's structured-output envelope (`-o json`).
 *
 * Every command prints exactly one JSON object of this shape on success or
 * failure: `{ success, meta:{timestamp,version}, data?|error? }`. This module
 * turns the *untrusted* bytes of a subprocess's stdout into a typed envelope or
 * a deterministic {@link ByrealParseError} — it never throws raw, never returns
 * a half-parsed value, and is hardened against the CLI emitting a banner, ANSI
 * colour codes, a truncated/garbage payload, or a pathologically large blob.
 */

/**
 * Maximum stdout we will attempt to parse — bounds memory on a runaway CLI.
 * B-05: kept as 1 MiB (1_024 * 1_024) to match cli.ts's DEFAULT_MAX_OUTPUT_BYTES
 * so there is no gap where output escapes the parse-rejection threshold but not
 * the process-kill cap.
 */
const MAX_OUTPUT_BYTES = 1_024 * 1_024;

/** A deterministic parse failure: the CLI output is not a usable envelope. */
export class ByrealParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ByrealParseError';
  }
}

// B-07: strip unknown top-level keys instead of passing them through. The
// parsed envelope is persisted verbatim in `executions.response_json`; a CLI
// that prints an extra top-level field (e.g. an echoed credential) must not have
// it carried into the database. Payload-bearing `data` stays `unknown` so the
// genuine result is preserved; only unrecognized *envelope/meta/error* keys drop.
const metaSchema = z.object({ timestamp: z.string().optional(), version: z.string().optional() });

const errorSchema = z.object({ code: z.string(), message: z.string() });

/** The validated envelope. `data` stays `unknown` — payload schemas live in `parse.ts`. */
export const envelopeSchema = z.object({
  success: z.boolean(),
  meta: metaSchema.optional(),
  data: z.unknown().optional(),
  error: errorSchema.optional(),
});

export type ByrealEnvelope = z.infer<typeof envelopeSchema>;

/** Strip ANSI/VT escape sequences a colourised CLI may interleave with JSON. */
const ANSI = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><]/g;

/**
 * Extract *every* balanced top-level JSON object from `text`, in order, ignoring
 * any leading/trailing/interleaving noise (a banner line, a trailing newline, a
 * stray warning, a JSON log line). String literals are scanned so a `}` inside a
 * JSON string never closes a level early. An unbalanced/truncated tail yields no
 * extra object.
 */
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

/**
 * Parse a CLI command's stdout into a typed {@link ByrealEnvelope}.
 *
 * @throws {@link ByrealParseError} on oversized output, no JSON object, invalid
 *   JSON, or an envelope that fails schema validation. Callers treat any throw
 *   as a rail miss and fall back to the seeded outcome.
 */
export function parseEnvelope(stdout: string): ByrealEnvelope {
  if (stdout.length > MAX_OUTPUT_BYTES) {
    throw new ByrealParseError('byreal output exceeds size bound');
  }

  const candidates = extractJsonObjects(stdout.replace(ANSI, ''));
  if (candidates.length === 0) {
    throw new ByrealParseError('byreal output contains no JSON object');
  }

  // B-06 (banner injection): collect *all* well-formed envelopes, not just the
  // first balanced object. A non-envelope banner object (`{"debug":true}`) is
  // skipped instead of aborting the parse. But the genuine CLI prints exactly
  // one envelope, so if more than one envelope-shaped object appears we refuse
  // to guess which is authoritative — a prepended/appended fake envelope must
  // not be able to substitute a forged fill. Fail closed: the caller degrades to
  // the deterministic seed fallback.
  const envelopes: ByrealEnvelope[] = [];
  for (const json of candidates) {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      continue; // Not valid JSON (e.g. `{ not: json }`) — ignore this candidate.
    }
    const parsed = envelopeSchema.safeParse(raw);
    if (parsed.success) envelopes.push(parsed.data);
  }

  if (envelopes.length === 0) {
    throw new ByrealParseError('byreal output is not a valid CLI envelope');
  }
  if (envelopes.length > 1) {
    throw new ByrealParseError('byreal output contains multiple CLI envelopes');
  }
  return envelopes[0] as ByrealEnvelope;
}
