CREATE TABLE validator_set_history (
    validator_epoch NUMERIC(78,0) PRIMARY KEY CHECK (validator_epoch >= 0 AND validator_epoch < power(2::numeric,256)),
    activation_batch_epoch NUMERIC(78,0) NOT NULL UNIQUE CHECK (activation_batch_epoch >= 0 AND activation_batch_epoch < power(2::numeric,256)),
    validators JSONB NOT NULL CHECK (jsonb_typeof(validators) = 'array' AND jsonb_array_length(validators) = 4),
    committee_digest TEXT NOT NULL CHECK (committee_digest ~ '^0x[0-9a-f]{64}$')
);
CREATE TRIGGER validator_set_history_immutable BEFORE UPDATE OR DELETE ON validator_set_history
    FOR EACH ROW EXECUTE FUNCTION reject_validator_state_rewrite();

ALTER TABLE pbft_epoch_views ADD COLUMN validator_epoch NUMERIC(78,0),
    ADD COLUMN committee_digest TEXT,
    ADD COLUMN protocol_version SMALLINT NOT NULL DEFAULT 2 CHECK (protocol_version IN (1,2,3));
ALTER TABLE pbft_epoch_views ADD CONSTRAINT epoch_committee_binding CHECK
    (protocol_version <> 3 OR (validator_epoch IS NOT NULL AND validator_epoch >= 0 AND validator_epoch < power(2::numeric,256)
        AND committee_digest IS NOT NULL AND committee_digest ~ '^0x[0-9a-f]{64}$'));

DO $migration$
DECLARE relation_name TEXT;
BEGIN
    FOREACH relation_name IN ARRAY ARRAY['pbft_pre_prepares','pbft_prepare_votes','pbft_prepared_states','pbft_commit_votes','pbft_commit_quorums'] LOOP
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', relation_name,relation_name || '_protocol_version_check');
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (protocol_version IN (1,2,3)),
            ADD COLUMN validator_epoch NUMERIC(78,0)',relation_name,relation_name || '_protocol_version_check');
        IF relation_name NOT IN ('pbft_commit_votes','pbft_commit_quorums') THEN
            EXECUTE format('ALTER TABLE %I ADD COLUMN committee_digest TEXT',relation_name);
        END IF;
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (protocol_version <> 3 OR
            (validator_epoch IS NOT NULL AND validator_epoch >= 0 AND validator_epoch < power(2::numeric,256)
             AND committee_digest IS NOT NULL AND committee_digest ~ ''^0x[0-9a-f]{64}$''))',relation_name,relation_name || '_validator_binding_check');
        -- Existing epoch keys remain a stronger uniqueness rule: one batch epoch
        -- can never be rebound to another committee. Explicit context is indexed too.
        EXECUTE format('CREATE UNIQUE INDEX %I ON %I (local_validator_identity,validator_epoch,epoch,view,protocol_version%s)',
            relation_name || '_validator_context',relation_name,
            CASE WHEN relation_name IN ('pbft_prepare_votes','pbft_commit_votes') THEN ',voter_identity' ELSE '' END);
    END LOOP;
END;
$migration$;

CREATE FUNCTION guard_validator_binding() RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE binding RECORD;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF ROW(NEW.validator_epoch,NEW.committee_digest,NEW.protocol_version)
            IS DISTINCT FROM ROW(OLD.validator_epoch,OLD.committee_digest,OLD.protocol_version) THEN
            RAISE EXCEPTION 'pinned validator epoch, committee and protocol are immutable';
        END IF;
    ELSIF NEW.protocol_version = 3 THEN
        EXECUTE format('SELECT * FROM %I.pbft_epoch_views WHERE local_validator_identity = $1 AND epoch = $2',TG_TABLE_SCHEMA)
            INTO binding USING NEW.local_validator_identity,NEW.epoch;
        IF binding.local_validator_identity IS NULL OR binding.protocol_version <> 3 OR binding.validator_epoch <> NEW.validator_epoch
            OR binding.committee_digest <> NEW.committee_digest OR binding.batch_id <> NEW.batch_id OR binding.message_root <> NEW.message_root THEN
            RAISE EXCEPTION 'signed evidence differs from pinned batch committee';
        END IF;
    END IF;
    RETURN NEW;
END;
$guard$;
CREATE TRIGGER pbft_epoch_validator_binding BEFORE UPDATE ON pbft_epoch_views
    FOR EACH ROW EXECUTE FUNCTION guard_validator_binding();
ALTER TABLE pbft_view_change_votes ADD COLUMN validator_epoch NUMERIC(78,0), ADD COLUMN committee_digest TEXT,
    ADD COLUMN protocol_version SMALLINT NOT NULL DEFAULT 2 CHECK (protocol_version IN (2,3));
ALTER TABLE pbft_new_views ADD COLUMN validator_epoch NUMERIC(78,0), ADD COLUMN committee_digest TEXT,
    ADD COLUMN protocol_version SMALLINT NOT NULL DEFAULT 2 CHECK (protocol_version IN (2,3));
CREATE UNIQUE INDEX view_change_validator_context ON pbft_view_change_votes
    (local_validator_identity,validator_epoch,epoch,target_view,voter_identity);
CREATE UNIQUE INDEX new_view_validator_context ON pbft_new_views (local_validator_identity,validator_epoch,epoch,view);
CREATE FUNCTION guard_view_validator_binding() RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE binding RECORD;
BEGIN
    EXECUTE format('SELECT * FROM %I.pbft_epoch_views WHERE local_validator_identity = $1 AND epoch = $2',TG_TABLE_SCHEMA)
        INTO binding USING NEW.local_validator_identity,NEW.epoch;
    IF binding.protocol_version IS DISTINCT FROM NEW.protocol_version OR (NEW.protocol_version = 3 AND
        (NEW.validator_epoch IS NULL OR NEW.committee_digest IS NULL OR NEW.validator_epoch IS DISTINCT FROM binding.validator_epoch
         OR NEW.committee_digest IS DISTINCT FROM binding.committee_digest
         OR NEW.envelope->>'validatorEpoch' IS DISTINCT FROM NEW.validator_epoch::text
         OR NEW.envelope->>'committeeDigest' IS DISTINCT FROM NEW.committee_digest)) THEN
        RAISE EXCEPTION 'view evidence differs from pinned validator committee';
    END IF;
    RETURN NEW;
END;
$guard$;
CREATE TRIGGER view_change_validator_binding BEFORE INSERT ON pbft_view_change_votes
    FOR EACH ROW EXECUTE FUNCTION guard_view_validator_binding();
CREATE TRIGGER new_view_validator_binding BEFORE INSERT ON pbft_new_views
    FOR EACH ROW EXECUTE FUNCTION guard_view_validator_binding();
DO $migration$
DECLARE relation_name TEXT;
BEGIN
    FOREACH relation_name IN ARRAY ARRAY['pbft_pre_prepares','pbft_prepare_votes','pbft_prepared_states','pbft_commit_votes','pbft_commit_quorums'] LOOP
        EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION guard_validator_binding()',relation_name || '_binding',relation_name);
    END LOOP;
END;
$migration$;
