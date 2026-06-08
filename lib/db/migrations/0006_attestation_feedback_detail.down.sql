-- Rollback 0006 — drop the off-chain attestation detail payload column.
ALTER TABLE attestations DROP COLUMN feedback_detail;
