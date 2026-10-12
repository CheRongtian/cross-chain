-- Cryptography is checked by strict source/package reads. SQL protects the
-- immutable, complete operational projection; it does not grant authorization.
CREATE TABLE delivery_batches (
    batch_record_id BIGINT PRIMARY KEY REFERENCES message_batches (batch_record_id)
        REFERENCES batch_quorum_certificates (batch_record_id),
    batch_id TEXT NOT NULL UNIQUE CHECK (batch_id ~ '^0x[0-9a-f]{64}$'),
    source_domain NUMERIC(78,0) NOT NULL,
    source_gateway TEXT NOT NULL CHECK (source_gateway ~ '^0x[0-9a-f]{40}$'),
    batch_epoch NUMERIC(78,0) NOT NULL,
    batch_version SMALLINT NOT NULL CHECK (batch_version = 1),
    message_root TEXT NOT NULL CHECK (message_root ~ '^0x[0-9a-f]{64}$'),
    leaf_count BIGINT NOT NULL CHECK (leaf_count > 0 AND leaf_count <= 9007199254740991),
    protocol_version SMALLINT NOT NULL CHECK (protocol_version IN (1,2,3)),
    validator_epoch NUMERIC(78,0),
    committee_digest TEXT NOT NULL CHECK (committee_digest ~ '^0x[0-9a-f]{64}$'),
    qc_digest TEXT NOT NULL CHECK (qc_digest ~ '^0x[0-9a-f]{64}$'),
    materialized_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((protocol_version = 3 AND validator_epoch IS NOT NULL) OR
           (protocol_version IN (1,2) AND validator_epoch IS NULL))
);

CREATE FUNCTION valid_delivery_siblings(value JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE AS $guard$
DECLARE item JSONB;
BEGIN
    IF jsonb_typeof(value) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP
        IF jsonb_typeof(item) IS DISTINCT FROM 'string' OR
            (item #>> '{}') !~ '^0x[0-9a-f]{64}$' THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
END;
$guard$;

CREATE TABLE delivery_jobs (
    delivery_job_id TEXT PRIMARY KEY,
    batch_record_id BIGINT NOT NULL REFERENCES delivery_batches (batch_record_id),
    source_message_id BIGINT NOT NULL,
    message_index BIGINT NOT NULL CHECK (message_index >= 0 AND message_index <= 9007199254740991),
    message_id TEXT NOT NULL CHECK (message_id ~ '^0x[0-9a-f]{64}$'),
    source_domain NUMERIC(78,0) NOT NULL,
    source_gateway TEXT NOT NULL CHECK (source_gateway ~ '^0x[0-9a-f]{40}$'),
    destination_domain NUMERIC(78,0) NOT NULL,
    destination_gateway TEXT NOT NULL CHECK (destination_gateway ~ '^0x[0-9a-f]{40}$'),
    destination_receiver TEXT NOT NULL CHECK (destination_receiver ~ '^0x[0-9a-f]{40}$'),
    proof_siblings JSONB NOT NULL CHECK (valid_delivery_siblings(proof_siblings)),
    status TEXT NOT NULL DEFAULT 'READY' CHECK (status = 'READY'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (batch_record_id,message_index),
    FOREIGN KEY (batch_record_id,source_message_id)
        REFERENCES message_batch_members (batch_record_id,source_message_id)
);

CREATE INDEX delivery_jobs_ready_order_idx ON delivery_jobs (batch_record_id,message_index,delivery_job_id);

CREATE FUNCTION guard_delivery_projection() RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE batch RECORD; certificate RECORD; member RECORD; projection RECORD;
    width BIGINT; depth INTEGER := 0;
BEGIN
    IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'READY delivery evidence is immutable'; END IF;
    EXECUTE format('SELECT * FROM %I.message_batches WHERE batch_record_id = $1 FOR SHARE',TG_TABLE_SCHEMA)
        INTO batch USING NEW.batch_record_id;
    IF batch.status IS DISTINCT FROM 'COMMITTED' THEN RAISE EXCEPTION 'delivery requires a COMMITTED batch'; END IF;
    IF TG_TABLE_NAME = 'delivery_batches' THEN
        EXECUTE format('SELECT * FROM %I.batch_quorum_certificates WHERE batch_record_id = $1',TG_TABLE_SCHEMA)
            INTO certificate USING NEW.batch_record_id;
        IF certificate.batch_record_id IS NULL OR
            ROW(NEW.source_domain,NEW.source_gateway,NEW.batch_epoch,NEW.batch_version,NEW.batch_id,NEW.message_root,NEW.leaf_count)
                IS DISTINCT FROM ROW(batch.source_domain,batch.source_gateway,batch.epoch,batch.version,batch.batch_id,batch.message_root,batch.message_count) OR
            ROW(NEW.protocol_version,NEW.validator_epoch,NEW.committee_digest,NEW.qc_digest)
                IS DISTINCT FROM ROW(certificate.protocol_version,certificate.validator_epoch,certificate.committee_digest,certificate.qc_digest) THEN
            RAISE EXCEPTION 'delivery projection differs from the canonical committed batch or QC';
        END IF;
    ELSE
        EXECUTE format('SELECT m.canonical_position,m.message_id AS assigned_message_id,s.* FROM %I.message_batch_members m
            JOIN %I.source_messages s ON s.id = m.source_message_id WHERE m.batch_record_id = $1 AND m.source_message_id = $2',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
            INTO member USING NEW.batch_record_id,NEW.source_message_id;
        EXECUTE format('SELECT * FROM %I.delivery_batches WHERE batch_record_id = $1',TG_TABLE_SCHEMA)
            INTO projection USING NEW.batch_record_id;
        IF member.id IS NULL OR projection.batch_record_id IS NULL OR member.status IS DISTINCT FROM 'FINALIZED' OR
            member.assigned_message_id IS DISTINCT FROM member.message_id OR
            ROW(NEW.message_index,NEW.message_id,NEW.source_domain,NEW.source_gateway,NEW.destination_domain,NEW.destination_gateway,NEW.destination_receiver)
                IS DISTINCT FROM ROW(member.canonical_position,member.message_id,member.source_domain,member.source_gateway,member.destination_domain,member.destination_gateway,member.destination_receiver) OR
            NEW.message_index >= projection.leaf_count OR
            NEW.delivery_job_id <> NEW.source_domain::text || ':' || NEW.source_gateway || ':' || projection.batch_id || ':' || NEW.message_index::text THEN
            RAISE EXCEPTION 'delivery job differs from immutable source membership';
        END IF;
        width := projection.leaf_count;
        WHILE width > 1 LOOP depth := depth + 1; width := (width + 1) / 2; END LOOP;
        IF jsonb_array_length(NEW.proof_siblings) <> depth THEN RAISE EXCEPTION 'delivery proof path length differs from leaf count'; END IF;
    END IF;
    RETURN NEW;
END;
$guard$;
CREATE TRIGGER delivery_batches_guard BEFORE INSERT OR UPDATE OR DELETE ON delivery_batches
    FOR EACH ROW EXECUTE FUNCTION guard_delivery_projection();
CREATE TRIGGER delivery_jobs_guard BEFORE INSERT OR UPDATE OR DELETE ON delivery_jobs
    FOR EACH ROW EXECUTE FUNCTION guard_delivery_projection();

CREATE FUNCTION require_complete_delivery_projection() RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE projection RECORD; jobs RECORD;
BEGIN
    EXECUTE format('SELECT * FROM %I.delivery_batches WHERE batch_record_id = $1',TG_TABLE_SCHEMA)
        INTO projection USING NEW.batch_record_id;
    EXECUTE format('SELECT COUNT(*) AS count,MIN(message_index) AS first,MAX(message_index) AS last
        FROM %I.delivery_jobs WHERE batch_record_id = $1',TG_TABLE_SCHEMA) INTO jobs USING NEW.batch_record_id;
    IF projection.batch_record_id IS NULL OR jobs.count <> projection.leaf_count OR
        jobs.first IS DISTINCT FROM 0::bigint OR jobs.last IS DISTINCT FROM projection.leaf_count - 1 THEN
        RAISE EXCEPTION 'delivery projection must contain exactly one job per sealed position atomically';
    END IF;
    RETURN NULL;
END;
$guard$;
CREATE CONSTRAINT TRIGGER delivery_batches_complete AFTER INSERT ON delivery_batches
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_complete_delivery_projection();
CREATE CONSTRAINT TRIGGER delivery_jobs_complete AFTER INSERT ON delivery_jobs
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_complete_delivery_projection();
