'use client';

import { useLayoutEffect, useRef } from 'react';

/**
 * A minimal FLIP (First-Last-Invert-Play) animator for the leaderboard rows.
 *
 * When agents re-sort, the DOM order changes instantly; FLIP makes that change
 * *read* as motion: it remembers each row's previous Y position (keyed by a
 * stable id), and on the next layout it sets a transform that puts the row back
 * where it was, then releases it so CSS eases it to its new spot. The result is
 * the "agent falls in rank" slide with no layout jank — the rows occupy their
 * final positions immediately; only the visual transform animates.
 *
 * Honors reduced-motion by skipping the invert entirely (rows just appear in
 * their new order). The map of positions is pruned to the live keys each pass so
 * it cannot grow without bound.
 */
export function useFlip(
  containerRef: React.RefObject<HTMLElement | null>,
  deps: readonly unknown[],
  reducedMotion: boolean,
): void {
  const positions = useRef<Map<string, number>>(new Map());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const rows = container.querySelectorAll<HTMLElement>('[data-flip-key]');
    const next = new Map<string, number>();

    rows.forEach((row) => {
      const key = row.dataset.flipKey;
      if (key === undefined) return;
      const top = row.getBoundingClientRect().top;
      next.set(key, top);
      if (reducedMotion) return;
      const prevTop = positions.current.get(key);
      if (prevTop === undefined) return;
      const dy = prevTop - top;
      if (Math.abs(dy) < 1) return;
      // First: jump the row back to its old position with no transition…
      row.style.transition = 'none';
      row.style.transform = `translateY(${dy}px)`;
      // …then, next frame, release it so CSS eases it to its real spot.
      requestAnimationFrame(() => {
        row.style.transition = '';
        row.style.transform = '';
      });
    });

    positions.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
