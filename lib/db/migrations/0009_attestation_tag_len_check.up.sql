-- ---------------------------------------------------------------------------
-- 0009 — DB-level length guards on attestation tags (A-06)
--
-- The application layer caps tag1/tag2 at 256 chars at encode time. These
-- CHECK constraints make the invariant bypass-proof for any direct DB write.
-- Both columns are nullable, so each guard short-circuits on NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE attestations
  ADD CONSTRAINT chk_attestations_tag1_len CHECK (tag1 IS NULL OR char_length(tag1) <= 256),
  ADD CONSTRAINT chk_attestations_tag2_len CHECK (tag2 IS NULL OR char_length(tag2) <= 256);
