DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'pbft_pre_prepares_prepare_reference_unique'
           AND conrelid = 'pbft_pre_prepares'::regclass
    ) THEN
        ALTER TABLE pbft_pre_prepares
            ADD CONSTRAINT pbft_pre_prepares_prepare_reference_unique
            UNIQUE (local_validator_identity, epoch, batch_id, message_root, proposal_digest);
    END IF;
END;
$migration$;

CREATE TABLE IF NOT EXISTS pbft_prepare_votes (
    local_validator_identity TEXT NOT NULL CHECK (local_validator_identity ~ '^0x[0-9a-f]{40}$'),
    voter_identity TEXT NOT NULL CHECK (voter_identity ~ '^0x[0-9a-f]{40}$'),
    epoch NUMERIC(78, 0) NOT NULL CHECK (epoch >= 0 AND epoch < power(2::numeric, 256)),
    source_domain NUMERIC(78, 0) NOT NULL CHECK (source_domain > 0 AND source_domain < power(2::numeric, 256)),
    source_gateway TEXT NOT NULL CHECK (source_gateway ~ '^0x[0-9a-f]{40}$'),
    batch_id TEXT NOT NULL CHECK (batch_id ~ '^0x[0-9a-f]{64}$'),
    message_root TEXT NOT NULL CHECK (message_root ~ '^0x[0-9a-f]{64}$'),
    proposal_digest TEXT NOT NULL CHECK (proposal_digest ~ '^0x[0-9a-f]{64}$'),
    prepare_digest TEXT NOT NULL CHECK (prepare_digest ~ '^0x[0-9a-f]{64}$'),
    voter_signature TEXT NOT NULL CHECK (voter_signature ~ '^0x[0-9a-f]{130}$'),
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (local_validator_identity, epoch, voter_identity),
    UNIQUE (local_validator_identity, epoch, prepare_digest),
    FOREIGN KEY (local_validator_identity, epoch, batch_id, message_root, proposal_digest)
        REFERENCES pbft_pre_prepares
            (local_validator_identity, epoch, batch_id, message_root, proposal_digest)
);

CREATE TABLE IF NOT EXISTS pbft_prepared_states (
    local_validator_identity TEXT NOT NULL CHECK (local_validator_identity ~ '^0x[0-9a-f]{40}$'),
    epoch NUMERIC(78, 0) NOT NULL CHECK (epoch >= 0 AND epoch < power(2::numeric, 256)),
    batch_id TEXT NOT NULL CHECK (batch_id ~ '^0x[0-9a-f]{64}$'),
    message_root TEXT NOT NULL CHECK (message_root ~ '^0x[0-9a-f]{64}$'),
    proposal_digest TEXT NOT NULL CHECK (proposal_digest ~ '^0x[0-9a-f]{64}$'),
    quorum_voters JSONB NOT NULL CHECK (jsonb_typeof(quorum_voters) = 'array' AND jsonb_array_length(quorum_voters) = 3),
    prepared_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (local_validator_identity, epoch),
    FOREIGN KEY (local_validator_identity, epoch, batch_id, message_root, proposal_digest)
        REFERENCES pbft_pre_prepares
            (local_validator_identity, epoch, batch_id, message_root, proposal_digest)
);

CREATE TABLE IF NOT EXISTS prepare_rejections (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    prepare_digest TEXT CHECK (prepare_digest ~ '^0x[0-9a-f]{64}$'),
    voter_identity TEXT CHECK (voter_identity ~ '^0x[0-9a-f]{40}$'),
    epoch NUMERIC(78, 0) CHECK (epoch >= 0 AND epoch < power(2::numeric, 256)),
    reason TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION reject_prepare_state_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
    RAISE EXCEPTION 'PREPARE votes, prepared state, and rejection evidence are immutable';
END;
$guard$;

DROP TRIGGER IF EXISTS pbft_prepare_votes_immutable ON pbft_prepare_votes;
CREATE TRIGGER pbft_prepare_votes_immutable BEFORE UPDATE OR DELETE ON pbft_prepare_votes
    FOR EACH ROW EXECUTE FUNCTION reject_prepare_state_rewrite();
DROP TRIGGER IF EXISTS pbft_prepared_states_immutable ON pbft_prepared_states;
CREATE TRIGGER pbft_prepared_states_immutable BEFORE UPDATE OR DELETE ON pbft_prepared_states
    FOR EACH ROW EXECUTE FUNCTION reject_prepare_state_rewrite();
DROP TRIGGER IF EXISTS prepare_rejections_immutable ON prepare_rejections;
CREATE TRIGGER prepare_rejections_immutable BEFORE UPDATE OR DELETE ON prepare_rejections
    FOR EACH ROW EXECUTE FUNCTION reject_prepare_state_rewrite();
