/**
 * mirror-merit.ts — Standalone auxiliary demo: call VectorMeritRegistry.attestScore
 *
 * This is the AUXILIARY path — it writes to the custom VectorMeritRegistry
 * contract (NOT ERC-8004). The primary reputation flow is the canonical ERC-8004
 * `giveFeedback` in `register-and-attest.ts`; this script demonstrates the
 * auxiliary merit cache that complements it.
 *
 * Flow:
 *   1. Encode an integer score via the project's canonical `encodeScoreValue`.
 *   2. Compute an evidenceHash (keccak256 of a canonical detail JSON) consistent
 *      with the feedbackHash pattern in `register-and-attest.ts`.
 *   3. Call `attestScore(agentId, score, evidenceHash)` on the deployed
 *      VectorMeritRegistry.
 *   4. Read back `latestScore(agentId)` and `isEligible(agentId, minScore)` and
 *      log the round-trip.
 *
 * Environment (reuses the same env var names as the primary runner):
 *
 *   DATABASE_URL='postgresql://placeholder/db' \
 *   MANTLE_TESTNET_RPC_URL='https://rpc.sepolia.mantle.xyz' \
 *   PUBLIC_BASE_URL='https://vector.example' \
 *   OPERATOR_PRIVATE_KEY=0x... \
 *   ATTESTOR_PRIVATE_KEY=0x... \
 *   MERIT_REGISTRY_ADDRESS=0x... \
 *   bun run scripts/chain/mirror-merit.ts [agentId] [scoreDecimal]
 *
 * - ATTESTOR_PRIVATE_KEY must correspond to the contract's current attestor.
 * - MERIT_REGISTRY_ADDRESS is the deployed VectorMeritRegistry address.
 * - agentId defaults to 1; scoreDecimal defaults to '73.500' (=> integer 74).
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ENV } from '@/lib/config/env';
import { canonicalJson } from '@/lib/attestation/build';
import { encodeScoreValue, VALUE_DECIMALS } from '@/lib/attestation/encode';
import { mantleSepolia } from '@/lib/chain/network';
import { parseAttestorKey } from '@/lib/chain/operator.schema';
import meritRegistryAbi from '@/lib/chain/abis/VectorMeritRegistry.json';

/** Upper bound on a single RPC round-trip. */
const RPC_TIMEOUT_MS = 10_000;

/** Default min-score threshold for the eligibility readback. */
const DEFAULT_MIN_SCORE = 50;

function requireEnvVar(name: string, value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required to run mirror-merit`);
  }
  return value;
}

async function main(): Promise<void> {
  const rpcUrl = requireEnvVar('MANTLE_TESTNET_RPC_URL', ENV.MANTLE_TESTNET_RPC_URL);
  const meritRegistryAddress = requireEnvVar(
    'MERIT_REGISTRY_ADDRESS',
    process.env.MERIT_REGISTRY_ADDRESS,
  ) as Address;

  // CLI args: agentId and scoreDecimal
  const agentId = BigInt(process.argv[2] ?? '1');
  const scoreDecimalStr = process.argv[3] ?? '73.500';

  // Encode the score via the canonical encoder (integer 0..100, valueDecimals=0)
  const integerScore = Number(encodeScoreValue(scoreDecimalStr));

  // Build a canonical evidence detail and hash it (mirrors the feedbackHash
  // pattern in register-and-attest.ts)
  const detail = {
    schema: 'vector.attestation.detail/1',
    agent: { onchain_id: agentId.toString() },
    score: { score_r: scoreDecimalStr, integer: integerScore, value_decimals: VALUE_DECIMALS },
    note: 'VectorMeritRegistry auxiliary attestation (mirror-merit demo)',
  };
  const detailJson = canonicalJson(detail);
  const evidenceHash = keccak256(toBytes(detailJson)) as Hex;

  // Build viem clients using the attestor key (same env var as the primary runner)
  const attestorAccount = privateKeyToAccount(parseAttestorKey(ENV.ATTESTOR_PRIVATE_KEY));
  const transport = http(rpcUrl, { timeout: RPC_TIMEOUT_MS });

  const publicClient = createPublicClient({ chain: mantleSepolia, transport });
  const walletClient = createWalletClient({
    account: attestorAccount,
    chain: mantleSepolia,
    transport,
  });

  console.log(`[mirror-merit] registry     = ${meritRegistryAddress}`);
  console.log(`[mirror-merit] attestor     = ${attestorAccount.address}`);
  console.log(`[mirror-merit] agentId      = ${agentId.toString()}`);
  console.log(`[mirror-merit] score        = ${scoreDecimalStr} => integer ${integerScore}`);
  console.log(`[mirror-merit] evidenceHash = ${evidenceHash}`);

  // 1. Write: attestScore
  console.log(`\n[mirror-merit] calling attestScore ...`);
  const txHash = await walletClient.writeContract({
    address: meritRegistryAddress,
    abi: meritRegistryAbi,
    functionName: 'attestScore',
    args: [agentId, integerScore, evidenceHash],
    account: attestorAccount,
    chain: mantleSepolia,
  } as Parameters<typeof walletClient.writeContract>[0]);
  console.log(`[mirror-merit] ✅ tx submitted: ${txHash}`);

  // Wait for receipt
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`[mirror-merit] ✅ tx mined: status=${receipt.status}, block=${receipt.blockNumber}`);

  // 2. Read back: latestScore
  const [score, evHash, timestamp, nonce, exists] = (await publicClient.readContract({
    address: meritRegistryAddress,
    abi: meritRegistryAbi,
    functionName: 'latestScore',
    args: [agentId],
  })) as [number, Hex, bigint, bigint, boolean];

  console.log(`\n[mirror-merit] readback — latestScore(${agentId.toString()}):`);
  console.log(`  score         = ${score}`);
  console.log(`  evidenceHash  = ${evHash}`);
  console.log(`  timestamp     = ${timestamp.toString()}`);
  console.log(`  nonce         = ${nonce.toString()}`);
  console.log(`  exists        = ${String(exists)}`);

  // 3. Read back: isEligible
  const eligible = (await publicClient.readContract({
    address: meritRegistryAddress,
    abi: meritRegistryAbi,
    functionName: 'isEligible',
    args: [agentId, DEFAULT_MIN_SCORE],
  })) as boolean;

  console.log(`  isEligible(${agentId.toString()}, ${DEFAULT_MIN_SCORE}) = ${String(eligible)}`);

  console.log(`\n[mirror-merit] DONE — auxiliary merit attestation round-trip complete.`);
}

main().catch((err) => {
  console.error('[mirror-merit] failed:', err);
  process.exit(1);
});
