CREATE TABLE IF NOT EXISTS validator_metadata (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    validator_address TEXT NOT NULL CHECK (validator_address ~ '^0x[0-9a-f]{40}$'),
    source_domain NUMERIC(78, 0) NOT NULL CHECK (source_domain > 0),
    source_gateway TEXT NOT NULL CHECK (source_gateway ~ '^0x[0-9a-f]{40}$'),
    finality_block_depth NUMERIC(78, 0) NOT NULL CHECK (finality_block_depth >= 0),
    protocol_version SMALLINT NOT NULL CHECK (protocol_version = 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS validated_batch_bindings (
    batch_id TEXT PRIMARY KEY CHECK (batch_id ~ '^0x[0-9a-f]{64}$'),
    batch_epoch NUMERIC(78, 0) NOT NULL CHECK (batch_epoch >= 0),
    message_root TEXT NOT NULL CHECK (message_root ~ '^0x[0-9a-f]{64}$'),
    message_count BIGINT NOT NULL CHECK (message_count > 0),
    ordered_occurrences JSONB NOT NULL CHECK (jsonb_typeof(ordered_occurrences) = 'array'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS validation_observations (
    batch_id TEXT NOT NULL REFERENCES validated_batch_bindings (batch_id),
    source_head_number NUMERIC(78, 0) NOT NULL CHECK (source_head_number >= 0),
    source_head_hash TEXT NOT NULL CHECK (source_head_hash ~ '^0x[0-9a-f]{64}$'),
    result TEXT NOT NULL CHECK (result IN ('VALID', 'INVALID')),
    reason TEXT NULL,
    validated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (batch_id, source_head_hash),
    CHECK ((result = 'VALID' AND reason IS NULL) OR (result = 'INVALID' AND reason IS NOT NULL))
);

CREATE OR REPLACE FUNCTION reject_validator_state_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
    RAISE EXCEPTION 'validator identity, snapshot bindings, and observations are immutable';
END;
$guard$;

DROP TRIGGER IF EXISTS validator_metadata_immutable ON validator_metadata;
CREATE TRIGGER validator_metadata_immutable BEFORE UPDATE OR DELETE ON validator_metadata
    FOR EACH ROW EXECUTE FUNCTION reject_validator_state_rewrite();
DROP TRIGGER IF EXISTS validated_batch_bindings_immutable ON validated_batch_bindings;
CREATE TRIGGER validated_batch_bindings_immutable BEFORE UPDATE OR DELETE ON validated_batch_bindings
    FOR EACH ROW EXECUTE FUNCTION reject_validator_state_rewrite();
DROP TRIGGER IF EXISTS validation_observations_immutable ON validation_observations;
CREATE TRIGGER validation_observations_immutable BEFORE UPDATE OR DELETE ON validation_observations
    FOR EACH ROW EXECUTE FUNCTION reject_validator_state_rewrite();
