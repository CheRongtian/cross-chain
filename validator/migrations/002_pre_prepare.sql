CREATE TABLE IF NOT EXISTS validator_committee (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    addresses JSONB NOT NULL CHECK (jsonb_typeof(addresses) = 'array' AND jsonb_array_length(addresses) = 4)
);

CREATE TABLE IF NOT EXISTS pbft_pre_prepares (
    local_validator_identity TEXT NOT NULL CHECK (local_validator_identity ~ '^0x[0-9a-f]{40}$'),
    epoch NUMERIC(78, 0) NOT NULL CHECK (epoch >= 0 AND epoch < power(2::numeric, 256)),
    batch_id TEXT NOT NULL CHECK (batch_id ~ '^0x[0-9a-f]{64}$'),
    message_root TEXT NOT NULL CHECK (message_root ~ '^0x[0-9a-f]{64}$'),
    proposal_digest TEXT NOT NULL CHECK (proposal_digest ~ '^0x[0-9a-f]{64}$'),
    primary_identity TEXT NOT NULL CHECK (primary_identity ~ '^0x[0-9a-f]{40}$'),
    primary_signature TEXT NOT NULL CHECK (primary_signature ~ '^0x[0-9a-f]{130}$'),
    direction TEXT NOT NULL CHECK (direction IN ('ISSUED', 'ACCEPTED')),
    status TEXT NOT NULL DEFAULT 'ACCEPTED' CHECK (status = 'ACCEPTED'),
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (local_validator_identity, epoch)
);

CREATE TABLE IF NOT EXISTS pre_prepare_rejections (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_digest TEXT CHECK (proposal_digest ~ '^0x[0-9a-f]{64}$'),
    primary_identity TEXT CHECK (primary_identity ~ '^0x[0-9a-f]{40}$'),
    epoch NUMERIC(78, 0) CHECK (epoch >= 0 AND epoch < power(2::numeric, 256)),
    reason TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS validator_committee_immutable ON validator_committee;
CREATE TRIGGER validator_committee_immutable BEFORE UPDATE OR DELETE ON validator_committee
    FOR EACH ROW EXECUTE FUNCTION reject_validator_state_rewrite();
DROP TRIGGER IF EXISTS pbft_pre_prepares_immutable ON pbft_pre_prepares;
CREATE TRIGGER pbft_pre_prepares_immutable BEFORE UPDATE OR DELETE ON pbft_pre_prepares
    FOR EACH ROW EXECUTE FUNCTION reject_validator_state_rewrite();
