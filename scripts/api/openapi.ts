#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import {
  agentDetailDto,
  agentDto,
  allocationDto,
  attestationDto,
  intentDto,
  leaderboardDto,
  leaderboardEntryDto,
  outcomeDto,
  policyEventDto,
  roundDto,
  scoreDto,
} from '@/lib/api/dto';

/**
 * Generate `docs/openapi.json` for the P1.5 read API from the very zod schemas
 * the routes serialize, so the spec can never drift from the code: change a DTO
 * and the contract regenerates. Run with `bun run api:openapi`; CI can diff the
 * result against the committed file to catch unintended contract changes.
 *
 * Component schemas are emitted fully inlined (`$refStrategy: 'none'`) so each is
 * self-contained, then referenced from the path responses — valid OpenAPI 3.0
 * with no dangling `$ref`s.
 */

const OUT = join(import.meta.dir, '..', '..', 'docs', 'openapi.json');

/** The named response components, keyed by their `#/components/schemas` name. */
const COMPONENTS: Record<string, ZodTypeAny> = {
  Round: roundDto,
  Agent: agentDto,
  LeaderboardEntry: leaderboardEntryDto,
  Leaderboard: leaderboardDto,
  Score: scoreDto,
  Intent: intentDto,
  PolicyEvent: policyEventDto,
  Outcome: outcomeDto,
  Allocation: allocationDto,
  Attestation: attestationDto,
  AgentDetail: agentDetailDto,
};

/**
 * The error body is a plain TS contract in `errors.ts` (no zod, by design), so
 * its JSON schema is written out directly here — mirroring `ErrorBody`'s shape.
 */
const ERROR_SCHEMA = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', description: 'Stable machine-readable error code.' },
        message: { type: 'string', description: 'Safe, user-facing message.' },
      },
    },
  },
} as const;

function buildComponents(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(COMPONENTS)) {
    schemas[name] = zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' });
  }
  schemas['ApiError'] = ERROR_SCHEMA;
  return schemas;
}

const ref = (name: string): Record<string, unknown> => ({
  $ref: `#/components/schemas/${name}`,
});

/** A keyset-paginated envelope wrapping `itemRef`'s array plus `next_cursor`. */
const pageOf = (itemName: string): Record<string, unknown> => ({
  type: 'object',
  required: ['data', 'next_cursor'],
  properties: {
    data: { type: 'array', items: ref(itemName) },
    next_cursor: {
      type: 'string',
      nullable: true,
      description: 'Opaque cursor for the next page, or null on the last page.',
    },
  },
});

const jsonResponse = (description: string, schema: Record<string, unknown>) => ({
  description,
  content: { 'application/json': { schema } },
});

const errorResponse = (description: string) => jsonResponse(description, ref('ApiError'));

const limitParam = {
  name: 'limit',
  in: 'query',
  required: false,
  description: 'Page size, 1..200 (default 50). Out-of-range or non-integer → 400.',
  schema: { type: 'integer', minimum: 1, maximum: 200 },
};

const cursorParam = {
  name: 'cursor',
  in: 'query',
  required: false,
  description: 'Opaque keyset cursor from a prior `next_cursor`. Malformed → 400.',
  schema: { type: 'string' },
};

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'Vector Read API',
    version: '1.5.0',
    description:
      'SWR-pollable read endpoints for the Vector merit layer: leaderboard, ' +
      'agent detail, the policy-event red-alert feed, and ERC-8004 attestations. ' +
      'All responses are `Cache-Control: no-store`. Money/score/capital values are ' +
      'exact decimal strings (never floats). Feeds use keyset pagination ordered ' +
      '`created_at DESC, id DESC`.',
  },
  paths: {
    '/api/leaderboard': {
      get: {
        summary: 'Agents ranked by current AgentScore with current-round allocation',
        parameters: [limitParam],
        responses: {
          '200': jsonResponse('Ranked leaderboard with round status.', ref('Leaderboard')),
          '400': errorResponse('Invalid query parameter.'),
          '503': errorResponse('Database unavailable.'),
        },
      },
    },
    '/api/agents/{id}': {
      get: {
        summary: 'One agent: score history, recent intents, decisions, and outcomes',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Agent UUID. Malformed → 400; well-formed but unknown → 404.',
            schema: { type: 'string', format: 'uuid' },
          },
          limitParam,
        ],
        responses: {
          '200': jsonResponse('Agent detail.', ref('AgentDetail')),
          '400': errorResponse('Malformed agent id or query parameter.'),
          '404': errorResponse('No agent with that id.'),
          '503': errorResponse('Database unavailable.'),
        },
      },
    },
    '/api/policy-events': {
      get: {
        summary: 'Referee decision feed (REJECT/HALT/CLIP/ALLOW), newest first',
        parameters: [limitParam, cursorParam],
        responses: {
          '200': jsonResponse('A keyset page of policy events.', pageOf('PolicyEvent')),
          '400': errorResponse('Invalid query parameter or cursor.'),
          '503': errorResponse('Database unavailable.'),
        },
      },
    },
    '/api/attestations': {
      get: {
        summary: 'ERC-8004 attestation mirror, newest first',
        parameters: [
          limitParam,
          cursorParam,
          {
            name: 'chain_state',
            in: 'query',
            required: false,
            description: 'Filter by chain state.',
            schema: { type: 'string', enum: ['optimistic', 'confirmed', 'failed'] },
          },
        ],
        responses: {
          '200': jsonResponse('A keyset page of attestations.', pageOf('Attestation')),
          '400': errorResponse('Invalid query parameter or cursor.'),
          '503': errorResponse('Database unavailable.'),
        },
      },
    },
  },
  components: { schemas: buildComponents() },
};

writeFileSync(OUT, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
console.log(`openapi: wrote ${OUT}`);
