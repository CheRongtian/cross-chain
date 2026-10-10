-- Preserve the original version-1 bytes and history as view zero.
DO $migration$
DECLARE
    relation_name TEXT;
    constraint_row RECORD;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'pbft_pre_prepares' AND column_name = 'view') THEN
        FOREACH relation_name IN ARRAY ARRAY['pbft_prepare_votes','pbft_prepared_states','pbft_commit_votes','pbft_commit_quorums'] LOOP
            FOR constraint_row IN SELECT conname FROM pg_constraint
                WHERE conrelid = relation_name::regclass AND contype = 'f' LOOP
                EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', relation_name, constraint_row.conname);
            END LOOP;
        END LOOP;
        FOREACH relation_name IN ARRAY ARRAY['pbft_pre_prepares','pbft_prepare_votes','pbft_prepared_states','pbft_commit_votes','pbft_commit_quorums'] LOOP
            EXECUTE format('ALTER TABLE %I ADD COLUMN view NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (view >= 0 AND view < power(2::numeric,256)),
                ADD COLUMN protocol_version SMALLINT NOT NULL DEFAULT 1 CHECK (protocol_version IN (1,2))', relation_name);
            FOR constraint_row IN SELECT conname FROM pg_constraint
                WHERE conrelid = relation_name::regclass AND contype IN ('p','u') LOOP
                EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', relation_name, constraint_row.conname);
            END LOOP;
            IF relation_name IN ('pbft_prepare_votes','pbft_commit_votes') THEN
                EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY (local_validator_identity,epoch,view,protocol_version,voter_identity)', relation_name);
            ELSE
                EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY (local_validator_identity,epoch,view,protocol_version)', relation_name);
            END IF;
        END LOOP;
        ALTER TABLE pbft_pre_prepares ADD CONSTRAINT pbft_pre_prepares_prepare_reference_unique
            UNIQUE (local_validator_identity,epoch,view,protocol_version,batch_id,message_root,proposal_digest);
        ALTER TABLE pbft_prepared_states ADD CONSTRAINT pbft_prepared_states_commit_reference_unique
            UNIQUE (local_validator_identity,epoch,view,protocol_version,batch_id,message_root,proposal_digest);
        ALTER TABLE pbft_prepare_votes ADD FOREIGN KEY (local_validator_identity,epoch,view,protocol_version,batch_id,message_root,proposal_digest)
            REFERENCES pbft_pre_prepares (local_validator_identity,epoch,view,protocol_version,batch_id,message_root,proposal_digest);
        ALTER TABLE pbft_prepared_states ADD FOREIGN KEY (local_validator_identity,epoch,view,protocol_version,batch_id,message_root,proposal_digest)
            REFERENCES pbft_pre_prepares (local_validator_identity,epoch,view,protocol_version,batch_id,message_root,proposal_digest);
        ALTER TABLE pbft_commit_votes ADD FOREIGN KEY (local_validator_identity,epoch,view,protocol_version,batch_id,message_root,proposal_digest)
            REFERENCES pbft_prepared_states (local_validator_identity,epoch,view,protocol_version,batch_id,message_root,proposal_digest);
        ALTER TABLE pbft_commit_quorums ADD FOREIGN KEY (local_validator_identity,epoch,view,protocol_version,batch_id,message_root,proposal_digest)
            REFERENCES pbft_prepared_states (local_validator_identity,epoch,view,protocol_version,batch_id,message_root,proposal_digest);
    END IF;
END;
$migration$;

CREATE TABLE IF NOT EXISTS pbft_epoch_views (
    local_validator_identity TEXT NOT NULL,
    epoch NUMERIC(78,0) NOT NULL CHECK (epoch >= 0 AND epoch < power(2::numeric,256)),
    batch_id TEXT NOT NULL CHECK (batch_id ~ '^0x[0-9a-f]{64}$'),
    message_root TEXT NOT NULL CHECK (message_root ~ '^0x[0-9a-f]{64}$'),
    current_view NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (current_view >= 0 AND current_view < power(2::numeric,256)),
    changing_view BOOLEAN NOT NULL DEFAULT false,
    finalized BOOLEAN NOT NULL DEFAULT false,
    progress_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (local_validator_identity,epoch)
);
CREATE TABLE IF NOT EXISTS pbft_view_change_votes (
    local_validator_identity TEXT NOT NULL,
    epoch NUMERIC(78,0) NOT NULL,
    target_view NUMERIC(78,0) NOT NULL CHECK (target_view > 0 AND target_view < power(2::numeric,256)),
    voter_identity TEXT NOT NULL CHECK (voter_identity ~ '^0x[0-9a-f]{40}$'),
    digest TEXT NOT NULL CHECK (digest ~ '^0x[0-9a-f]{64}$'),
    envelope JSONB NOT NULL,
    PRIMARY KEY (local_validator_identity,epoch,target_view,voter_identity),
    FOREIGN KEY (local_validator_identity,epoch) REFERENCES pbft_epoch_views
);
CREATE TABLE IF NOT EXISTS pbft_new_views (
    local_validator_identity TEXT NOT NULL,
    epoch NUMERIC(78,0) NOT NULL,
    view NUMERIC(78,0) NOT NULL CHECK (view > 0 AND view < power(2::numeric,256)),
    digest TEXT NOT NULL CHECK (digest ~ '^0x[0-9a-f]{64}$'),
    envelope JSONB NOT NULL,
    PRIMARY KEY (local_validator_identity,epoch,view),
    FOREIGN KEY (local_validator_identity,epoch) REFERENCES pbft_epoch_views
);
CREATE OR REPLACE FUNCTION guard_pbft_epoch_view()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
    has_evidence BOOLEAN;
BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'consensus history cannot be deleted'; END IF;
    IF ROW(NEW.local_validator_identity,NEW.epoch,NEW.batch_id,NEW.message_root)
        IS DISTINCT FROM ROW(OLD.local_validator_identity,OLD.epoch,OLD.batch_id,OLD.message_root)
        OR NEW.current_view < OLD.current_view
        OR (OLD.finalized AND (NOT NEW.finalized OR NEW.current_view <> OLD.current_view OR NEW.changing_view)) THEN
        RAISE EXCEPTION 'consensus identity, monotonic view, and finality are immutable';
    END IF;
    IF NEW.current_view > OLD.current_view THEN
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.pbft_new_views WHERE local_validator_identity = $1 AND epoch = $2 AND view = $3)', TG_TABLE_SCHEMA)
            INTO has_evidence USING NEW.local_validator_identity, NEW.epoch, NEW.current_view;
        IF NOT has_evidence THEN RAISE EXCEPTION 'advancing view requires persisted NEW_VIEW evidence'; END IF;
    END IF;
    RETURN NEW;
END;
$guard$;
DROP TRIGGER IF EXISTS pbft_epoch_views_guard ON pbft_epoch_views;
CREATE TRIGGER pbft_epoch_views_guard BEFORE UPDATE OR DELETE ON pbft_epoch_views FOR EACH ROW EXECUTE FUNCTION guard_pbft_epoch_view();
DROP TRIGGER IF EXISTS pbft_view_change_votes_immutable ON pbft_view_change_votes;
CREATE TRIGGER pbft_view_change_votes_immutable BEFORE UPDATE OR DELETE ON pbft_view_change_votes FOR EACH ROW EXECUTE FUNCTION reject_validator_state_rewrite();
DROP TRIGGER IF EXISTS pbft_new_views_immutable ON pbft_new_views;
CREATE TRIGGER pbft_new_views_immutable BEFORE UPDATE OR DELETE ON pbft_new_views FOR EACH ROW EXECUTE FUNCTION reject_validator_state_rewrite();
