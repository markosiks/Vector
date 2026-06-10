-- Rollback 0009 — drop the attestation tag length CHECK constraints.
ALTER TABLE attestations
  DROP CONSTRAINT IF EXISTS chk_attestations_tag1_len,
  DROP CONSTRAINT IF EXISTS chk_attestations_tag2_len;
