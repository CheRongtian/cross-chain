CREATE TABLE relayer_submissions (
    delivery_job_id TEXT PRIMARY KEY REFERENCES delivery_jobs (delivery_job_id),
    relayer_address TEXT NOT NULL CHECK (relayer_address ~ '^0x[0-9a-f]{40}$'),
    destination_domain NUMERIC(78,0) NOT NULL CHECK (destination_domain > 0 AND destination_domain < power(2::numeric,256)),
    destination_gateway TEXT NOT NULL CHECK (destination_gateway ~ '^0x[0-9a-f]{40}$'),
    package_digest TEXT NOT NULL CHECK (package_digest ~ '^0x[0-9a-f]{64}$'),
    transaction_hash TEXT NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE FUNCTION guard_relayer_submission() RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE job RECORD;
BEGIN
    IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'relay submission records are immutable'; END IF;
    EXECUTE format('SELECT * FROM %I.delivery_jobs WHERE delivery_job_id = $1',TG_TABLE_SCHEMA)
        INTO job USING NEW.delivery_job_id;
    IF job.delivery_job_id IS NULL OR job.status IS DISTINCT FROM 'READY' OR
        ROW(NEW.destination_domain,NEW.destination_gateway) IS DISTINCT FROM ROW(job.destination_domain,job.destination_gateway) THEN
        RAISE EXCEPTION 'relay submission destination differs from canonical READY job';
    END IF;
    RETURN NEW;
END;
$guard$;
CREATE TRIGGER relayer_submissions_guard BEFORE INSERT OR UPDATE OR DELETE ON relayer_submissions
    FOR EACH ROW EXECUTE FUNCTION guard_relayer_submission();
