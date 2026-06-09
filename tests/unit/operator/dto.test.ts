import { describe, expect, test } from 'bun:test';

import {
  attackResultDto,
  killSwitchDto,
  operatorActionDto,
  toAttackResultDto,
  toKillSwitchDto,
  toOperatorActionDto,
} from '@/lib/api/dto';
import type { KillSwitchRow, OperatorActionRow } from '@/lib/db/schema';
import type { AttackInjectionResult } from '@/lib/operator/inject-attack';

/**
 * Unit: the operator DTO mappers. Each must emit exactly the documented shape
 * (validated against its own zod schema), serialize timestamps to ISO strings,
 * and fold the fail-open default for a missing kill-switch row.
 */

describe('toKillSwitchDto', () => {
  test('maps a row, ISO-serializing updated_at', () => {
    const row: KillSwitchRow = {
      id: 1,
      active: true,
      reason: 'incident-42',
      set_by: 'operator',
      updated_at: new Date('2026-01-02T03:04:05.000Z'),
    };
    const dto = toKillSwitchDto(row);
    expect(killSwitchDto.parse(dto)).toEqual(dto);
    expect(dto).toEqual({
      active: true,
      reason: 'incident-42',
      set_by: 'operator',
      updated_at: '2026-01-02T03:04:05.000Z',
    });
  });

  test('a null row is the fail-open default (inactive, no timestamps)', () => {
    expect(toKillSwitchDto(null)).toEqual({
      active: false,
      reason: null,
      set_by: null,
      updated_at: null,
    });
  });
});

describe('toOperatorActionDto', () => {
  test('maps an audit row, preserving the structured detail', () => {
    const row: OperatorActionRow = {
      id: '11111111-1111-1111-1111-111111111111',
      kind: 'attack',
      actor: 'operator',
      agent_id: '22222222-2222-2222-2222-222222222222',
      detail_json: { decision: 'REJECT', rule_fired: 'fresh_wallet_transfer_block' },
      created_at: new Date('2026-01-02T03:04:05.000Z'),
    };
    const dto = toOperatorActionDto(row);
    expect(operatorActionDto.parse(dto)).toEqual(dto);
    expect(dto.detail).toEqual({ decision: 'REJECT', rule_fired: 'fresh_wallet_transfer_block' });
    expect(dto.created_at).toBe('2026-01-02T03:04:05.000Z');
  });
});

describe('toAttackResultDto', () => {
  const base: AttackInjectionResult = {
    decision: {
      decision: 'REJECT',
      severity: 'hard',
      rule_fired: 'fresh_wallet_transfer_block',
      detail: {},
    },
    intentId: '33333333-3333-3333-3333-333333333333',
    intentHash: '0xabc',
    duplicate: false,
    target: {
      roundId: '44444444-4444-4444-4444-444444444444',
      leader: {
        id: '55555555-5555-5555-5555-555555555555',
        display_name: 'seed-leader',
        owner: 'ops',
        strategy_kind: 'seed',
        status: 'active',
        score_current: '90',
        agent_id_onchain: null,
        allocation_amount: '1000',
        created_at: new Date(),
      },
      seed: { id: 'seed-leader' } as never,
      allocation: '1000',
    },
  };

  test('maps a real REJECT injection', () => {
    const dto = toAttackResultDto(base);
    expect(attackResultDto.parse(dto)).toEqual(dto);
    expect(dto).toMatchObject({
      decision: 'REJECT',
      severity: 'hard',
      rule_fired: 'fresh_wallet_transfer_block',
      duplicate: false,
      target_display_name: 'seed-leader',
      intent_id: '33333333-3333-3333-3333-333333333333',
    });
  });

  test('an idempotent retry carries the persisted intent_id and duplicate=true', () => {
    const dto = toAttackResultDto({ ...base, duplicate: true });
    expect(dto.intent_id).toBe('33333333-3333-3333-3333-333333333333');
    expect(dto.duplicate).toBe(true);
  });

  test('a null intent_id (defensive case) maps to null', () => {
    const dto = toAttackResultDto({ ...base, intentId: null, duplicate: true });
    expect(dto.intent_id).toBeNull();
    expect(dto.duplicate).toBe(true);
  });
});
