-- Operational coordination only; delivery and signed evidence stay unchanged.
CREATE TABLE relayer_worker_ids (
    worker_id TEXT PRIMARY KEY CHECK (worker_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    lock_id INTEGER GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL
);

CREATE TABLE relayer_job_leases (
    delivery_job_id TEXT PRIMARY KEY REFERENCES delivery_jobs (delivery_job_id),
    owner_id TEXT NOT NULL REFERENCES relayer_worker_ids (worker_id),
    owner_session_id UUID NOT NULL,
    fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
    lease_acquired_at TIMESTAMPTZ NOT NULL,
    lease_expires_at TIMESTAMPTZ NOT NULL,
    last_renewed_at TIMESTAMPTZ NOT NULL,
    released_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX relayer_job_leases_expiry_idx ON relayer_job_leases (lease_expires_at,delivery_job_id);

CREATE FUNCTION guard_relayer_job_lease() RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'lease fencing history cannot be deleted'; END IF;
    IF TG_OP = 'UPDATE' THEN
        IF ROW(NEW.delivery_job_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.delivery_job_id,OLD.created_at) OR
            NEW.fencing_token < OLD.fencing_token OR NEW.fencing_token - OLD.fencing_token > 1 THEN
            RAISE EXCEPTION 'lease identity is immutable and fencing tokens are monotonic';
        END IF;
        IF NEW.fencing_token = OLD.fencing_token AND
            ROW(NEW.owner_id,NEW.owner_session_id,NEW.lease_acquired_at) IS DISTINCT FROM ROW(OLD.owner_id,OLD.owner_session_id,OLD.lease_acquired_at) THEN
            RAISE EXCEPTION 'ownership change requires a new fencing token';
        END IF;
        IF NEW.fencing_token > OLD.fencing_token AND OLD.lease_expires_at > clock_timestamp() THEN
            RAISE EXCEPTION 'an active lease cannot be taken over';
        END IF;
    END IF;
    RETURN NEW;
END;
$guard$;
CREATE TRIGGER relayer_job_leases_guard BEFORE UPDATE OR DELETE ON relayer_job_leases
    FOR EACH ROW EXECUTE FUNCTION guard_relayer_job_lease();
