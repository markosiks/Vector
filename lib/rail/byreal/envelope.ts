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

const metaSchema = z
  .object({ timestamp: z.string().optional(), version: z.string().optional() })
  .passthrough();

const errorSchema = z.object({ code: z.string(), message: z.string() }).passthrough();

/** The validated envelope. `data` stays `unknown` — payload schemas live in `parse.ts`. */
export const envelopeSchema = z
  .object({
    success: z.boolean(),
    meta: metaSchema.optional(),
    data: z.unknown().optional(),
    error: errorSchema.optional(),
  })
  .passthrough();

export type ByrealEnvelope = z.infer<typeof envelopeSchema>;

/** Strip ANSI/VT escape sequences a colourised CLI may interleave with JSON. */
const ANSI = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><]/g;

/**
 * Extract the first balanced top-level JSON object from `text`, ignoring any
 * leading/trailing noise (a banner line, a trailing newline, a stray warning).
 * Returns the substring `{…}` or `null` when no balanced object is present.
 * String literals are scanned so a `}` inside a JSON string never closes early.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // Unbalanced — truncated output.
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

  const json = extractJsonObject(stdout.replace(ANSI, ''));
  if (json === null) {
    throw new ByrealParseError('byreal output contains no JSON object');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ByrealParseError('byreal output is not valid JSON');
  }

  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ByrealParseError('byreal output is not a valid CLI envelope');
  }
  return parsed.data;
}
