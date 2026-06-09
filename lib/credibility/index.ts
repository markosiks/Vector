/**
 * Pure, framework-free logic for the credibility screens — Attestation Log and
 * Agent detail (P2.3).
 *
 * Like `lib/arena`, everything here is a total function over the read-API DTOs —
 * no React, no DOM, no clock (clocks are injected) — so explorer links, chain-
 * state badges, the score breakdown, the EWMA curve geometry, and the
 * intent↔referee correlation are unit-, fuzz-, and golden-testable on their own.
 * The components under `app/attestations` and `app/agents/[id]` are the thin
 * rendering shell over these.
 */
export * from './explorer';
export * from './chain-state';
export * from './components';
export * from './ewma';
export * from './referee';
export * from './format';
