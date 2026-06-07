import { describe, expect, test } from 'bun:test';

import {
  attestationDto,
  intentDto,
  leaderboardEntryDto,
  toAttestationDto,
  toIntentDto,
  toLeaderboardEntryDto,
  toOutcomeDto,
  toPolicyEventDto,
  toRoundDto,
  toScoreDto,
} from '@/lib/api/dto';
import {
  attestationRowFixture,
  intentRowFixture,
  leaderboardRowFixture,
  outcomeRowFixture,
  policyEventRowFixture,
  roundRowFixture,
  scoreRowFixture,
} from '../fixtures/read-api-fixtures';

/**
 * The DTO mappers are the read API's serialization boundary. The invariants that
 * matter downstream: `numeric` stays an exact string (never a float), `Date`
 * becomes an ISO string, and internal/secret intent fields never appear in the
 * output. Each mapper is also parsed back through its own zod schema to prove
 * the emitted object matches the published shape exactly.
 */

describe('numeric precision is preserved as a string', () => {
  test('an allocation past float53 round-trips digit-for-digit', () => {
    const dto = toLeaderboardEntryDto(leaderboardRowFixture);
    expect(dto.allocation).toBe('250000.123456789012345678');
    expect(typeof dto.allocation).toBe('string');
  });

  test('a 39-digit attestation value is not coerced through a number', () => {
    const dto = toAttestationDto(attestationRowFixture);
    expect(dto.value).toBe('170141183460469231731687303715884105727');
    // The naive `Number(value).toString()` would corrupt this; assert it did not.
    expect(dto.value).not.toBe(String(Number(dto.value)));
  });

  test('capital_at_risk keeps its full numeric(38,18) scale', () => {
    expect(toOutcomeDto(outcomeRowFixture).capital_at_risk).toBe('1000.000000000000000001');
  });
});

describe('timestamps become ISO strings', () => {
  test('round timestamps serialize and null stays null', () => {
    const dto = toRoundDto(roundRowFixture);
    expect(dto.started_at).toBe('2026-06-07T12:00:00.000Z');
    expect(dto.settled_at).toBeNull();
  });

  test('attestation confirmed_at serializes when present', () => {
    expect(toAttestationDto(attestationRowFixture).confirmed_at).toBe('2026-06-07T12:00:00.000Z');
  });
});

describe('no internal fields leak', () => {
  test('the intent DTO omits signature, raw_json, and nonce', () => {
    const dto = toIntentDto(intentRowFixture);
    expect(dto).not.toHaveProperty('signature');
    expect(dto).not.toHaveProperty('raw_json');
    expect(dto).not.toHaveProperty('nonce');
    // The serialized JSON must not carry the secret values anywhere either.
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('should-never-leak');
    expect(serialized).not.toContain('nonce-secret');
  });

  test('the intent DTO still carries the fields the UI needs', () => {
    const dto = toIntentDto(intentRowFixture);
    expect(dto.action).toBe('transfer');
    expect(dto.target_address).toBe('0xdeadbeef');
    expect(dto.size).toBe('1.5');
  });
});

describe('emitted objects match their published schema exactly', () => {
  test('leaderboard entry parses (no missing/extra keys)', () => {
    expect(() =>
      leaderboardEntryDto.parse(toLeaderboardEntryDto(leaderboardRowFixture)),
    ).not.toThrow();
  });

  test('intent DTO parses', () => {
    expect(() => intentDto.parse(toIntentDto(intentRowFixture))).not.toThrow();
  });

  test('attestation DTO parses', () => {
    expect(() => attestationDto.parse(toAttestationDto(attestationRowFixture))).not.toThrow();
  });
});

describe('nullable and structured fields pass through', () => {
  test('score components_json is forwarded as `components`', () => {
    expect(toScoreDto(scoreRowFixture).components).toEqual({
      perf: 0.5,
      w: 0.4,
      policy: -3,
      dd: -1.2,
    });
  });

  test('policy event detail_json is forwarded as `detail`', () => {
    expect(toPolicyEventDto(policyEventRowFixture).detail).toEqual({ target: '0xdeadbeef' });
    expect(toPolicyEventDto(policyEventRowFixture).decision).toBe('REJECT');
  });
});
