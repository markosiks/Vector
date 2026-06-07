/**
 * Pure, framework-free logic for the Arena / Leaderboard screen (P1.6).
 *
 * Everything here is a total function over plain data — no React, no DOM, no
 * clock — so the screen's behaviour (ranking, capital-flow, reputation-drop,
 * red-flash, formatting, easing) is unit-, fuzz-, and golden-testable on its own.
 * The components in `app/arena/` are the thin rendering shell over these.
 */
export * from './types';
export * from './format';
export * from './easing';
export * from './rank';
export * from './flow';
export * from './reputation';
export * from './flash';
