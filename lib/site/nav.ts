/**
 * Pure helpers for the global navigation chrome — kept out of the client
 * component so the logic is unit-testable without a DOM.
 */

/** `true` when `pathname` is exactly `href` or a sub-route of it. */
export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
