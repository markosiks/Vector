'use client';

import type { ReactNode } from 'react';

import styles from './arena.module.css';

export interface RedFlashProps {
  /**
   * A monotonically-changing key that increments each poll a REJECT/HALT fires.
   * Changing this value triggers a new flash animation while keeping the live
   * region mounted so screen readers can announce the updated content.
   */
  readonly flashKey: number;
  /** How many policy blocks fired in the triggering poll (for the banner copy). */
  readonly count: number;
}

/**
 * The screen-level red-flash on a policy block. It is a non-interactive overlay
 * plus a short-lived banner. Under reduced motion the overlay holds a static red
 * vignette instead of strobing (see the CSS).
 *
 * Accessibility: the `aria-live="assertive"` region is kept permanently in the
 * DOM — its text is updated in place rather than re-mounting via `key`. Mounting
 * a fresh live region resets the AT's tracking so content present at mount time
 * is not announced. Only subsequent DOM mutations inside a stable live region are
 * announced.
 *
 * CSS animation replay: the overlay (aria-hidden) may freely use `key` to
 * remount. The banner animation is replayed by keying a non-live inner `<span>`
 * so the outer `aria-live` div is never unmounted.
 */
export function RedFlash({ flashKey, count }: RedFlashProps): ReactNode {
  const label = count > 1 ? `${count} POLICY BLOCKS` : 'POLICY BLOCK';
  return (
    <>
      {/*
       * Overlay: aria-hidden, so remounting via key is fine for AT.
       * The key swap causes React to unmount+remount, replaying the CSS animation.
       */}
      {flashKey > 0 && (
        <div
          key={`overlay-${flashKey}`}
          className={`${styles.flashOverlay} ${styles.flashOverlayActive}`}
          aria-hidden="true"
          data-testid="flash-overlay"
        />
      )}
      {/*
       * Live region: permanently mounted. Text changes are announced by AT.
       * The inner keyed <span> replays the banner CSS animation on each new flash
       * without ever remounting the outer aria-live div.
       */}
      <div
        className={styles.flashBanner}
        role="status"
        aria-live="assertive"
        data-testid="flash-banner"
      >
        {flashKey > 0 ? (
          <span key={`banner-inner-${flashKey}`} className={styles.flashBannerInner}>
            ⛔ {label} — REFEREE REJECT
          </span>
        ) : null}
      </div>
    </>
  );
}
