-- Application code verifies cryptography; these guards enforce atomic structural state.
CREATE TABLE IF NOT EXISTS batch_quorum_certificates (
    batch_record_id BIGINT PRIMARY KEY REFERENCES message_batches (batch_record_id),
    protocol_version SMALLINT NOT NULL CHECK (protocol_version = 1),
    source_domain NUMERIC(78, 0) NOT NULL CHECK (source_domain > 0 AND source_domain < power(2::numeric, 256)),
    source_gateway TEXT NOT NULL CHECK (source_gateway ~ '^0x[0-9a-f]{40}$'),
    epoch NUMERIC(78, 0) NOT NULL CHECK (epoch >= 0 AND epoch < power(2::numeric, 256)),
    batch_id TEXT NOT NULL UNIQUE CHECK (batch_id ~ '^0x[0-9a-f]{64}$'),
    message_root TEXT NOT NULL CHECK (message_root ~ '^0x[0-9a-f]{64}$'),
    proposal_digest TEXT NOT NULL CHECK (proposal_digest ~ '^0x[0-9a-f]{64}$'),
    committee_digest TEXT NOT NULL CHECK (committee_digest ~ '^0x[0-9a-f]{64}$'),
    qc_digest TEXT NOT NULL UNIQUE CHECK (qc_digest ~ '^0x[0-9a-f]{64}$'),
    persisted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (source_domain, source_gateway, epoch)
);
CREATE TABLE IF NOT EXISTS batch_quorum_certificate_signatures (
    batch_record_id BIGINT NOT NULL REFERENCES batch_quorum_certificates (batch_record_id),
    voter_identity TEXT NOT NULL CHECK (voter_identity ~ '^0x[0-9a-f]{40}$'),
    commit_digest TEXT NOT NULL CHECK (commit_digest ~ '^0x[0-9a-f]{64}$'),
    signature TEXT NOT NULL CHECK (signature ~ '^0x[0-9a-f]{130}$'),
    PRIMARY KEY (batch_record_id, voter_identity)
);

CREATE OR REPLACE FUNCTION guard_batch_certificate_write()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
    batch RECORD;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'persisted QC and signatures are immutable';
    END IF;
    EXECUTE format('SELECT * FROM %I.message_batches WHERE batch_record_id = $1 FOR UPDATE', TG_TABLE_SCHEMA)
        INTO batch USING NEW.batch_record_id;
    IF batch.status IS DISTINCT FROM 'CONSENSUS_PENDING' THEN
        RAISE EXCEPTION 'QC evidence can only be inserted for a CONSENSUS_PENDING batch';
    END IF;
    IF TG_TABLE_NAME = 'batch_quorum_certificates' THEN
        IF ROW(NEW.source_domain, NEW.source_gateway, NEW.epoch, NEW.batch_id, NEW.message_root)
           IS DISTINCT FROM ROW(batch.source_domain, batch.source_gateway, batch.epoch, batch.batch_id, batch.message_root) THEN
            RAISE EXCEPTION 'QC does not match the persisted batch';
        END IF;
    END IF;
    RETURN NEW;
END;
$guard$;
DROP TRIGGER IF EXISTS batch_quorum_certificates_guard ON batch_quorum_certificates;
CREATE TRIGGER batch_quorum_certificates_guard BEFORE INSERT OR UPDATE OR DELETE ON batch_quorum_certificates
    FOR EACH ROW EXECUTE FUNCTION guard_batch_certificate_write();
DROP TRIGGER IF EXISTS batch_quorum_certificate_signatures_guard ON batch_quorum_certificate_signatures;
CREATE TRIGGER batch_quorum_certificate_signatures_guard BEFORE INSERT OR UPDATE OR DELETE ON batch_quorum_certificate_signatures
    FOR EACH ROW EXECUTE FUNCTION guard_batch_certificate_write();

CREATE OR REPLACE FUNCTION require_atomic_batch_certificate()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
    batch RECORD;
    certificate_count INTEGER;
BEGIN
    EXECUTE format('SELECT * FROM %I.message_batches WHERE batch_record_id = $1', TG_TABLE_SCHEMA)
        INTO batch USING NEW.batch_record_id;
    EXECUTE format(
        'SELECT COUNT(*) FROM %I.batch_quorum_certificates q
         WHERE q.batch_record_id = $1 AND q.source_domain = $2 AND q.source_gateway = $3
           AND q.epoch = $4 AND q.batch_id = $5 AND q.message_root = $6
           AND (SELECT COUNT(*) FROM %I.batch_quorum_certificate_signatures s
                WHERE s.batch_record_id = q.batch_record_id) BETWEEN 3 AND 4',
        TG_TABLE_SCHEMA, TG_TABLE_SCHEMA
    ) INTO certificate_count USING batch.batch_record_id, batch.source_domain, batch.source_gateway,
        batch.epoch, batch.batch_id, batch.message_root;
    IF batch.status = 'COMMITTED' THEN
        IF certificate_count <> 1 THEN
            RAISE EXCEPTION 'COMMITTED batch requires a matching complete QC';
        END IF;
    ELSIF TG_TABLE_NAME <> 'message_batches' OR certificate_count <> 0 THEN
        RAISE EXCEPTION 'QC persistence and COMMITTED transition must be atomic';
    END IF;
    RETURN NULL;
END;
$guard$;
DROP TRIGGER IF EXISTS batch_certificate_atomic ON batch_quorum_certificates;
CREATE CONSTRAINT TRIGGER batch_certificate_atomic AFTER INSERT ON batch_quorum_certificates
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_atomic_batch_certificate();
DROP TRIGGER IF EXISTS batch_certificate_signatures_atomic ON batch_quorum_certificate_signatures;
CREATE CONSTRAINT TRIGGER batch_certificate_signatures_atomic AFTER INSERT ON batch_quorum_certificate_signatures
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_atomic_batch_certificate();
DROP TRIGGER IF EXISTS message_batches_certificate_atomic ON message_batches;
CREATE CONSTRAINT TRIGGER message_batches_certificate_atomic AFTER INSERT OR UPDATE ON message_batches
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_atomic_batch_certificate();

CREATE OR REPLACE FUNCTION guard_message_batch_record()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
    cursor_value NUMERIC;
    previous_epoch NUMERIC;
    membership RECORD;
    certificate_count INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'BUILDING' THEN
            RAISE EXCEPTION 'new lifecycle batches must start BUILDING';
        END IF;
        EXECUTE format(
            'SELECT next_block FROM %I.indexer_cursors
             WHERE chain_domain = $1 AND source_gateway = $2 FOR UPDATE', TG_TABLE_SCHEMA
        ) INTO cursor_value USING NEW.source_domain, NEW.source_gateway;
        IF cursor_value IS NULL THEN
            RAISE EXCEPTION 'source cursor is required before creating a lifecycle batch';
        END IF;
        EXECUTE format(
            'SELECT MAX(epoch) FROM %I.message_batches
             WHERE source_domain = $1 AND source_gateway = $2', TG_TABLE_SCHEMA
        ) INTO previous_epoch USING NEW.source_domain, NEW.source_gateway;
        IF previous_epoch IS NOT NULL AND NEW.epoch <> previous_epoch + 1 THEN
            RAISE EXCEPTION 'next batch epoch must increment the persisted epoch exactly once';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'BUILDING' THEN
            RAISE EXCEPTION 'sealed lifecycle batch records cannot be deleted';
        END IF;
        RETURN OLD;
    END IF;

    IF ROW(NEW.batch_record_id, NEW.source_domain, NEW.source_gateway, NEW.epoch, NEW.version, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.batch_record_id, OLD.source_domain, OLD.source_gateway, OLD.epoch, OLD.version, OLD.created_at) THEN
        RAISE EXCEPTION 'batch record identity, scope, epoch, and version are immutable';
    END IF;
    IF OLD.status <> 'BUILDING' AND
       ROW(NEW.batch_id, NEW.message_root, NEW.message_count)
       IS DISTINCT FROM ROW(OLD.batch_id, OLD.message_root, OLD.message_count) THEN
        RAISE EXCEPTION 'sealed batch commitment is immutable';
    END IF;
    IF (OLD.sealed_at IS NOT NULL AND NEW.sealed_at IS DISTINCT FROM OLD.sealed_at)
       OR (OLD.consensus_pending_at IS NOT NULL AND NEW.consensus_pending_at IS DISTINCT FROM OLD.consensus_pending_at)
       OR (OLD.committed_at IS NOT NULL AND NEW.committed_at IS DISTINCT FROM OLD.committed_at) THEN
        RAISE EXCEPTION 'persisted batch transition timestamps cannot be rewritten';
    END IF;
    IF NEW.status = 'COMMITTED' AND OLD.status <> 'COMMITTED' THEN
        IF OLD.status <> 'CONSENSUS_PENDING' THEN
            RAISE EXCEPTION 'COMMITTED requires CONSENSUS_PENDING and PBFT quorum authorization';
        END IF;
        EXECUTE format(
            'SELECT COUNT(*) FROM %I.batch_quorum_certificates q
             WHERE q.batch_record_id = $1 AND q.source_domain = $2 AND q.source_gateway = $3
               AND q.epoch = $4 AND q.batch_id = $5 AND q.message_root = $6
               AND (SELECT COUNT(*) FROM %I.batch_quorum_certificate_signatures s
                    WHERE s.batch_record_id = q.batch_record_id) BETWEEN 3 AND 4',
            TG_TABLE_SCHEMA, TG_TABLE_SCHEMA
        ) INTO certificate_count USING NEW.batch_record_id, NEW.source_domain, NEW.source_gateway,
            NEW.epoch, NEW.batch_id, NEW.message_root;
        IF certificate_count <> 1 THEN
            RAISE EXCEPTION 'COMMITTED requires PBFT quorum authorization through a matching QC';
        END IF;
    END IF;
    IF NEW.status <> OLD.status AND NOT (
        (OLD.status = 'BUILDING' AND NEW.status = 'SEALED')
        OR (OLD.status = 'SEALED' AND NEW.status = 'CONSENSUS_PENDING')
        OR (OLD.status = 'CONSENSUS_PENDING' AND NEW.status = 'COMMITTED')
    ) THEN
        RAISE EXCEPTION 'illegal batch lifecycle transition: % to %', OLD.status, NEW.status;
    END IF;

    IF OLD.status = 'BUILDING' AND NEW.status = 'SEALED' THEN
        EXECUTE format(
            'SELECT COUNT(*) AS member_count, COUNT(m.canonical_position) AS positioned_count,
                    MIN(m.canonical_position) AS first_position, MAX(m.canonical_position) AS last_position,
                    BOOL_AND(s.status = ''FINALIZED'' AND s.source_domain = $2
                        AND s.source_gateway = $3 AND s.message_id = m.message_id) AS valid_members
             FROM %I.message_batch_members m JOIN %I.source_messages s ON s.id = m.source_message_id
             WHERE m.batch_record_id = $1', TG_TABLE_SCHEMA, TG_TABLE_SCHEMA
        ) INTO membership USING NEW.batch_record_id, NEW.source_domain, NEW.source_gateway;
        IF membership.member_count = 0 OR NEW.message_count IS NULL
           OR membership.member_count <> NEW.message_count
           OR membership.positioned_count <> NEW.message_count
           OR membership.first_position <> 0
           OR membership.last_position <> NEW.message_count - 1
           OR membership.valid_members IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'cannot seal empty or inconsistent batch membership';
        END IF;
    END IF;
    RETURN NEW;
END;
$guard$;
