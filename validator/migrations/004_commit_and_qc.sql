DO $migration$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
        WHERE conname = 'pbft_prepared_states_commit_reference_unique'
          AND conrelid = 'pbft_prepared_states'::regclass) THEN
        ALTER TABLE pbft_prepared_states ADD CONSTRAINT pbft_prepared_states_commit_reference_unique
            UNIQUE (local_validator_identity, epoch, batch_id, message_root, proposal_digest);
    END IF;
END;
$migration$;

CREATE TABLE IF NOT EXISTS pbft_commit_votes (
    local_validator_identity TEXT NOT NULL CHECK (local_validator_identity ~ '^0x[0-9a-f]{40}$'),
    voter_identity TEXT NOT NULL CHECK (voter_identity ~ '^0x[0-9a-f]{40}$'),
    epoch NUMERIC(78, 0) NOT NULL CHECK (epoch >= 0 AND epoch < power(2::numeric, 256)),
    source_domain NUMERIC(78, 0) NOT NULL CHECK (source_domain > 0 AND source_domain < power(2::numeric, 256)),
    source_gateway TEXT NOT NULL CHECK (source_gateway ~ '^0x[0-9a-f]{40}$'),
    batch_id TEXT NOT NULL CHECK (batch_id ~ '^0x[0-9a-f]{64}$'),
    message_root TEXT NOT NULL CHECK (message_root ~ '^0x[0-9a-f]{64}$'),
    proposal_digest TEXT NOT NULL CHECK (proposal_digest ~ '^0x[0-9a-f]{64}$'),
    committee_digest TEXT NOT NULL CHECK (committee_digest ~ '^0x[0-9a-f]{64}$'),
    commit_digest TEXT NOT NULL CHECK (commit_digest ~ '^0x[0-9a-f]{64}$'),
    voter_signature TEXT NOT NULL CHECK (voter_signature ~ '^0x[0-9a-f]{130}$'),
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (local_validator_identity, epoch, voter_identity),
    UNIQUE (local_validator_identity, epoch, commit_digest),
    FOREIGN KEY (local_validator_identity, epoch, batch_id, message_root, proposal_digest)
        REFERENCES pbft_prepared_states (local_validator_identity, epoch, batch_id, message_root, proposal_digest)
);

CREATE TABLE IF NOT EXISTS pbft_commit_quorums (
    local_validator_identity TEXT NOT NULL,
    epoch NUMERIC(78, 0) NOT NULL,
    batch_id TEXT NOT NULL,
    message_root TEXT NOT NULL,
    proposal_digest TEXT NOT NULL,
    committee_digest TEXT NOT NULL CHECK (committee_digest ~ '^0x[0-9a-f]{64}$'),
    qc_digest TEXT NOT NULL CHECK (qc_digest ~ '^0x[0-9a-f]{64}$'),
    quorum_voters JSONB NOT NULL CHECK (jsonb_typeof(quorum_voters) = 'array' AND jsonb_array_length(quorum_voters) = 3),
    reached_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (local_validator_identity, epoch),
    FOREIGN KEY (local_validator_identity, epoch, batch_id, message_root, proposal_digest)
        REFERENCES pbft_prepared_states (local_validator_identity, epoch, batch_id, message_root, proposal_digest)
);

CREATE TABLE IF NOT EXISTS commit_rejections (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    commit_digest TEXT CHECK (commit_digest ~ '^0x[0-9a-f]{64}$'),
    voter_identity TEXT CHECK (voter_identity ~ '^0x[0-9a-f]{40}$'),
    epoch NUMERIC(78, 0) CHECK (epoch >= 0 AND epoch < power(2::numeric, 256)),
    reason TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION reject_commit_state_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
    RAISE EXCEPTION 'COMMIT votes, quorum state, and rejection evidence are immutable';
END;
$guard$;
DROP TRIGGER IF EXISTS pbft_commit_votes_immutable ON pbft_commit_votes;
CREATE TRIGGER pbft_commit_votes_immutable BEFORE UPDATE OR DELETE ON pbft_commit_votes
    FOR EACH ROW EXECUTE FUNCTION reject_commit_state_rewrite();
DROP TRIGGER IF EXISTS pbft_commit_quorums_immutable ON pbft_commit_quorums;
CREATE TRIGGER pbft_commit_quorums_immutable BEFORE UPDATE OR DELETE ON pbft_commit_quorums
    FOR EACH ROW EXECUTE FUNCTION reject_commit_state_rewrite();
DROP TRIGGER IF EXISTS commit_rejections_immutable ON commit_rejections;
CREATE TRIGGER commit_rejections_immutable BEFORE UPDATE OR DELETE ON commit_rejections
    FOR EACH ROW EXECUTE FUNCTION reject_commit_state_rewrite();
