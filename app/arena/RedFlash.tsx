'use client';

import type { ReactNode } from 'react';

import styles from './arena.module.css';

export interface RedFlashProps {
  /**
   * A monotonically-changing key that increments each poll a REJECT/HALT fires.
   * Changing the key re-mounts the overlay so its one-shot CSS animation replays;
   * an unchanged key means no new block, so the overlay stays dormant.
   */
  readonly flashKey: number;
  /** How many policy blocks fired in the triggering poll (for the banner copy). */
  readonly count: number;
}

/**
 * The screen-level red-flash on a policy block. It is a non-interactive overlay
 * plus a short-lived banner; both are keyed on `flashKey` so a *new* block
 * replays the animation while a steady feed head does not. Under reduced motion
 * the overlay holds a static red vignette instead of strobing (see the CSS).
 */
export function RedFlash({ flashKey, count }: RedFlashProps): ReactNode {
  if (flashKey === 0) return null;
  const label = count > 1 ? `${count} POLICY BLOCKS` : 'POLICY BLOCK';
  return (
    <>
      <div
        key={`overlay-${flashKey}`}
        className={`${styles.flashOverlay} ${styles.flashOverlayActive}`}
        aria-hidden="true"
        data-testid="flash-overlay"
      />
      <div
        key={`banner-${flashKey}`}
        className={styles.flashBanner}
        role="status"
        aria-live="assertive"
        data-testid="flash-banner"
      >
        ⛔ {label} — REFEREE REJECT
      </div>
    </>
  );
}
