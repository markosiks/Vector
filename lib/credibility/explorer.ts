import { CONFIG } from '@/lib/config/constants';

/**
 * Block-explorer link construction for the credibility screens (P2.3).
 *
 * Every link is built from the single seeded `CONFIG.chain` source (the same
 * explorer base + chain id the on-chain clients use) — never a second hardcoded
 * literal — so the demo's "click through to Mantle Sepolia" story can never
 * drift from the network the attestations were actually written to.
 *
 * The inputs (`tx_hash`, `block_number`, `target_address`) come straight off the
 * read API and are therefore **untrusted**: a malformed or partially-written
 * attestation, or a fuzzed DTO, can carry a non-hash `tx_hash` or a non-numeric
 * block. Each builder validates its argument and returns `null` rather than
 * emitting a broken `href`, so the UI degrades to plain, unlinked text instead
 * of rendering a link that 404s or — worse — injects an attacker-controlled URL.
 */

/** A 0x-prefixed 32-byte transaction hash. */
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
/** A 0x-prefixed 20-byte address. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** A non-negative decimal block number with no sign, point, or leading `+`. */
const BLOCK_RE = /^[0-9]+$/;

/** The explorer origin from the seeded config, with any trailing slashes removed. */
function explorerBase(base: string): string {
  return base.replace(/\/+$/, '');
}

/** `true` when `hash` is a well-formed 32-byte tx hash, narrowing the type. */
export function isValidTxHash(hash: string | null | undefined): hash is string {
  return typeof hash === 'string' && TX_HASH_RE.test(hash);
}

/** `true` when `addr` is a well-formed 20-byte address, narrowing the type. */
export function isValidAddress(addr: string | null | undefined): addr is string {
  return typeof addr === 'string' && ADDRESS_RE.test(addr);
}

/** `true` when `block` is a non-negative integer string, narrowing the type. */
export function isValidBlockNumber(block: string | null | undefined): block is string {
  return typeof block === 'string' && BLOCK_RE.test(block);
}

/**
 * Explorer URL for a transaction, or `null` if `txHash` is not a valid hash.
 * `base` defaults to the seeded explorer origin; it is injectable for tests.
 */
export function explorerTxUrl(
  txHash: string | null | undefined,
  base: string = CONFIG.chain.mantle_explorer_base_url,
): string | null {
  if (!isValidTxHash(txHash)) return null;
  return `${explorerBase(base)}/tx/${txHash}`;
}

/** Explorer URL for a block, or `null` if `block` is not a non-negative integer. */
export function explorerBlockUrl(
  block: string | null | undefined,
  base: string = CONFIG.chain.mantle_explorer_base_url,
): string | null {
  if (!isValidBlockNumber(block)) return null;
  return `${explorerBase(base)}/block/${block}`;
}

/** Explorer URL for an address, or `null` if `addr` is not a valid address. */
export function explorerAddressUrl(
  addr: string | null | undefined,
  base: string = CONFIG.chain.mantle_explorer_base_url,
): string | null {
  if (!isValidAddress(addr)) return null;
  return `${explorerBase(base)}/address/${addr}`;
}
