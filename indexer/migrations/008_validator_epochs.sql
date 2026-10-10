CREATE TABLE batch_consensus_bindings (
    batch_record_id BIGINT PRIMARY KEY REFERENCES message_batches (batch_record_id),
    validator_epoch NUMERIC(78,0) CHECK (validator_epoch >= 0 AND validator_epoch < power(2::numeric,256)),
    committee_digest TEXT CHECK (committee_digest ~ '^0x[0-9a-f]{64}$'),
    protocol_version SMALLINT NOT NULL CHECK (protocol_version IN (1,2,3)),
    CHECK (protocol_version <> 3 OR (validator_epoch IS NOT NULL AND committee_digest IS NOT NULL))
);
-- Existing evidence did not sign validatorEpoch. Retain its original version,
-- and reserve old pending instances against accidental v3 reconfiguration.
INSERT INTO batch_consensus_bindings (batch_record_id,protocol_version,committee_digest)
    SELECT b.batch_record_id,COALESCE(q.protocol_version,2),q.committee_digest
    FROM message_batches b LEFT JOIN batch_quorum_certificates q USING (batch_record_id)
    WHERE b.status IN ('CONSENSUS_PENDING','COMMITTED');
CREATE FUNCTION reject_batch_consensus_binding_rewrite() RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
    RAISE EXCEPTION 'batch validator epoch and committee are immutable';
END;
$guard$;
CREATE TRIGGER batch_consensus_bindings_immutable BEFORE UPDATE OR DELETE ON batch_consensus_bindings
    FOR EACH ROW EXECUTE FUNCTION reject_batch_consensus_binding_rewrite();
ALTER TABLE batch_quorum_certificates ADD COLUMN validator_epoch NUMERIC(78,0);
ALTER TABLE batch_quorum_certificates DROP CONSTRAINT batch_quorum_certificates_protocol_version_check;
ALTER TABLE batch_quorum_certificates ADD CONSTRAINT batch_quorum_certificates_protocol_version_check CHECK (protocol_version IN (1,2,3));
ALTER TABLE batch_quorum_certificates ADD CONSTRAINT batch_quorum_certificates_validator_epoch_check
    CHECK (protocol_version <> 3 OR (validator_epoch IS NOT NULL AND validator_epoch >= 0 AND validator_epoch < power(2::numeric,256)));
CREATE FUNCTION guard_source_qc_committee() RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE binding RECORD;
BEGIN
    EXECUTE format('SELECT * FROM %I.batch_consensus_bindings WHERE batch_record_id = $1',TG_TABLE_SCHEMA)
        INTO binding USING NEW.batch_record_id;
    IF binding.batch_record_id IS NOT NULL THEN
        IF NEW.protocol_version <> binding.protocol_version OR (binding.protocol_version = 3 AND
            (NEW.validator_epoch IS DISTINCT FROM binding.validator_epoch OR NEW.committee_digest IS DISTINCT FROM binding.committee_digest))
            OR (binding.committee_digest IS NOT NULL AND NEW.committee_digest <> binding.committee_digest) THEN
            RAISE EXCEPTION 'QC differs from pinned source batch committee';
        END IF;
    ELSIF NEW.protocol_version = 3 THEN
        RAISE EXCEPTION 'version-three QC requires a pinned source batch committee';
    END IF;
    RETURN NEW;
END;
$guard$;
CREATE TRIGGER batch_quorum_certificate_committee BEFORE INSERT ON batch_quorum_certificates
    FOR EACH ROW EXECUTE FUNCTION guard_source_qc_committee();
