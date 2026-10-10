-- QC metadata evolves; source messages, batch commitments and membership do not.
ALTER TABLE batch_quorum_certificates ADD COLUMN IF NOT EXISTS view NUMERIC(78,0) NOT NULL DEFAULT 0
    CHECK (view >= 0 AND view < power(2::numeric,256));
ALTER TABLE batch_quorum_certificates DROP CONSTRAINT IF EXISTS batch_quorum_certificates_protocol_version_check;
ALTER TABLE batch_quorum_certificates ADD CONSTRAINT batch_quorum_certificates_protocol_version_check
    CHECK (protocol_version IN (1,2));
ALTER TABLE batch_quorum_certificates DROP CONSTRAINT IF EXISTS batch_quorum_certificates_legacy_view_check;
ALTER TABLE batch_quorum_certificates ADD CONSTRAINT batch_quorum_certificates_legacy_view_check
    CHECK (protocol_version <> 1 OR view = 0);
