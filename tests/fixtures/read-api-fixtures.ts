import type {
  AgentRow,
  AttestationRow,
  IntentRow,
  OutcomeRow,
  PolicyEventRow,
  RoundRow,
  ScoreRow,
} from '@/lib/db/schema';
import type { LeaderboardRow } from '@/lib/db/repos/leaderboard';

/**
 * Hand-built database rows for the read-API unit tests. Each carries the exact
 * column types the driver returns — `Date` for `timestamptz`, decimal `string`
 * for `numeric` — so the DTO mappers are exercised against realistic input.
 */

const AT = new Date('2026-06-07T12:00:00.000Z');

export const agentRowFixture: AgentRow = {
  id: '11111111-1111-1111-1111-111111111111',
  agent_id_onchain: null,
  display_name: 'seed-leader',
  owner: 'ops',
  strategy_kind: 'seed',
  status: 'active',
  score_current: '73.250',
  created_at: AT,
};

export const leaderboardRowFixture: LeaderboardRow = {
  ...agentRowFixture,
  allocation_amount: '250000.123456789012345678',
};

export const roundRowFixture: RoundRow = {
  id: '22222222-2222-2222-2222-222222222222',
  index: 4,
  state: 'open',
  seed_ref: 'slice-a',
  started_at: AT,
  settled_at: null,
};

export const scoreRowFixture: ScoreRow = {
  id: '33333333-3333-3333-3333-333333333333',
  agent_id: agentRowFixture.id,
  round_id: roundRowFixture.id,
  raw_r: '12.34567800',
  score_r: '73.250',
  components_json: { perf: 0.5, w: 0.4, policy: -3, dd: -1.2 },
  created_at: AT,
};

export const intentRowFixture: IntentRow = {
  id: '44444444-4444-4444-4444-444444444444',
  round_id: roundRowFixture.id,
  agent_id: agentRowFixture.id,
  intent_hash: '0xabc',
  action: 'transfer',
  market: null,
  side: null,
  size: '1.5',
  leverage: null,
  tp: null,
  sl: null,
  max_slippage: null,
  target_address: '0xdeadbeef',
  nonce: 'nonce-secret-1',
  ttl: null,
  signature: '0xsignature-should-never-leak',
  raw_json: { secret: 'should-never-leak' },
  created_at: AT,
};

export const policyEventRowFixture: PolicyEventRow = {
  id: '55555555-5555-5555-5555-555555555555',
  intent_id: intentRowFixture.id,
  agent_id: agentRowFixture.id,
  round_id: roundRowFixture.id,
  rule_fired: 'fresh_wallet_transfer_block',
  decision: 'REJECT',
  severity: 'hard',
  detail_json: { target: '0xdeadbeef' },
  created_at: AT,
};

export const outcomeRowFixture: OutcomeRow = {
  id: '66666666-6666-6666-6666-666666666666',
  execution_id: null,
  agent_id: agentRowFixture.id,
  round_id: roundRowFixture.id,
  pnl_realized: '10.5',
  pnl_marked: '0',
  capital_at_risk: '1000.000000000000000001',
  fees: '0.25',
  position_delta: '-2',
  drawdown: '0.05',
  created_at: AT,
};

export const attestationRowFixture: AttestationRow = {
  id: '77777777-7777-7777-7777-777777777777',
  agent_id: agentRowFixture.id,
  round_id: roundRowFixture.id,
  value: '170141183460469231731687303715884105727',
  value_decimals: 3,
  tag1: 'agentscore',
  tag2: null,
  feedback_uri: 'ipfs://x',
  feedback_hash: `0x${'a'.repeat(64)}`,
  chain_state: 'confirmed',
  tx_hash: `0x${'b'.repeat(64)}`,
  block_number: '12345678',
  created_at: AT,
  confirmed_at: AT,
};
