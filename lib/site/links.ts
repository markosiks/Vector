import { explorerAddressUrl } from '@/lib/credibility/explorer';

/**
 * Site-wide external references (P3.4 demo polish).
 *
 * Single source for the public links the chrome (nav, landing, error screens)
 * renders: the GitHub repository and the deployed VectorMeritRegistry contract
 * on the Mantle Sepolia explorer. Pure and server/client safe — no secrets, no
 * `server-only` imports — so both the client nav and server pages may use it.
 */

/** The public GitHub repository this deployment is built from. */
export const GITHUB_REPO_URL = 'https://github.com/markosiks/Vector';

/**
 * The deployed VectorMeritRegistry address (Mantle Sepolia). Non-secret; the
 * default mirrors `.env.example` / `docs/final/vector-contract-deployed.md` and
 * a deployment may override it via `MERIT_REGISTRY_ADDRESS`.
 */
export const DEFAULT_MERIT_REGISTRY_ADDRESS = '0x1894Be93D9ACA27b7A6AF0eaD56354D9EbA0Ffb9';

/**
 * Explorer URL for the merit-registry contract, built through the same
 * validated {@link explorerAddressUrl} the credibility screens use. An invalid
 * override degrades to the known-good default rather than emitting a broken or
 * attacker-controlled href.
 */
export function meritRegistryExplorerUrl(
  address: string | undefined = process.env.MERIT_REGISTRY_ADDRESS,
): string {
  return (
    explorerAddressUrl(address ?? null) ?? (explorerAddressUrl(DEFAULT_MERIT_REGISTRY_ADDRESS) as string)
  );
}
