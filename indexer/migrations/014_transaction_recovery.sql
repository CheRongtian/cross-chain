-- Operational lock identity and optimistic revision; no business identity changes.
ALTER TABLE transaction_intents ADD COLUMN recovery_lock_id INTEGER GENERATED ALWAYS AS IDENTITY UNIQUE;
ALTER TABLE transaction_intents ADD COLUMN recovery_version BIGINT NOT NULL DEFAULT 0 CHECK (recovery_version >= 0);

CREATE FUNCTION guard_transaction_recovery_fields() RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
    IF NEW.recovery_lock_id IS DISTINCT FROM OLD.recovery_lock_id THEN
        RAISE EXCEPTION 'transaction recovery lock identity is immutable';
    END IF;
    NEW.recovery_version := OLD.recovery_version + 1;
    RETURN NEW;
END;
$guard$;
CREATE TRIGGER a_transaction_recovery_fields BEFORE UPDATE ON transaction_intents
    FOR EACH ROW EXECUTE FUNCTION guard_transaction_recovery_fields();

CREATE TABLE transaction_broadcast_events (
    event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    attempt_id BIGINT NOT NULL REFERENCES transaction_attempts (attempt_id),
    broadcast_sequence BIGINT NOT NULL CHECK (broadcast_sequence > 0),
    parent_event_id BIGINT,
    endpoint_label TEXT CHECK (endpoint_label ~ '^rpc-[0-9]+$'),
    started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    completed_at TIMESTAMPTZ,
    result_class TEXT CHECK (result_class IN ('ACCEPTED','ERROR','RECONCILED')),
    error_class TEXT CHECK (error_class IN ('TRANSIENT_RPC_ERROR','AMBIGUOUS_BROADCAST','ALREADY_KNOWN',
        'REPLACEMENT_UNDERPRICED','NONCE_TOO_LOW','DETERMINISTIC_REJECTION')),
    returned_tx_hash TEXT CHECK (returned_tx_hash ~ '^0x[0-9a-f]{64}$'),
    UNIQUE (attempt_id,broadcast_sequence),
    UNIQUE (attempt_id,event_id),
    FOREIGN KEY (attempt_id,parent_event_id) REFERENCES transaction_broadcast_events (attempt_id,event_id),
    CHECK ((parent_event_id IS NULL) = (endpoint_label IS NULL)),
    CHECK ((completed_at IS NULL AND result_class IS NULL AND error_class IS NULL AND returned_tx_hash IS NULL) OR
        (completed_at IS NOT NULL AND result_class IS NOT NULL AND completed_at >= started_at AND
         ((result_class = 'ERROR' AND error_class IS NOT NULL AND returned_tx_hash IS NULL) OR
          (result_class IN ('ACCEPTED','RECONCILED') AND error_class IS NULL AND returned_tx_hash IS NOT NULL))))
);
CREATE INDEX transaction_broadcast_events_unresolved_idx ON transaction_broadcast_events (attempt_id,event_id) WHERE completed_at IS NULL;

CREATE FUNCTION guard_transaction_broadcast_event() RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE attempt RECORD; parent RECORD;
BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'broadcast history cannot be deleted'; END IF;
    EXECUTE format('SELECT * FROM %I.transaction_attempts WHERE attempt_id = $1',TG_TABLE_SCHEMA) INTO attempt USING NEW.attempt_id;
    IF TG_OP = 'INSERT' THEN
        IF NEW.completed_at IS NOT NULL THEN RAISE EXCEPTION 'broadcast events must begin unresolved'; END IF;
        IF NEW.parent_event_id IS NOT NULL THEN
            EXECUTE format('SELECT * FROM %I.transaction_broadcast_events WHERE event_id = $1',TG_TABLE_SCHEMA) INTO parent USING NEW.parent_event_id;
            IF parent.attempt_id IS DISTINCT FROM NEW.attempt_id OR parent.parent_event_id IS NOT NULL OR parent.completed_at IS NOT NULL THEN
                RAISE EXCEPTION 'endpoint send requires its unresolved logical broadcast';
            END IF;
        END IF;
    ELSE
        IF OLD.completed_at IS NOT NULL OR ROW(NEW.event_id,NEW.attempt_id,NEW.broadcast_sequence,NEW.parent_event_id,NEW.endpoint_label,NEW.started_at)
            IS DISTINCT FROM ROW(OLD.event_id,OLD.attempt_id,OLD.broadcast_sequence,OLD.parent_event_id,OLD.endpoint_label,OLD.started_at) THEN
            RAISE EXCEPTION 'broadcast history is immutable; an unresolved result may be completed once';
        END IF;
        IF NEW.completed_at IS NULL THEN RAISE EXCEPTION 'broadcast result completion is required'; END IF;
        IF NEW.returned_tx_hash IS NOT NULL AND NEW.returned_tx_hash IS DISTINCT FROM attempt.transaction_hash THEN
            RAISE EXCEPTION 'broadcast result hash differs from signed identity';
        END IF;
    END IF;
    RETURN NEW;
END;
$guard$;
CREATE TRIGGER transaction_broadcast_events_guard BEFORE INSERT OR UPDATE OR DELETE ON transaction_broadcast_events
    FOR EACH ROW EXECUTE FUNCTION guard_transaction_broadcast_event();

CREATE FUNCTION advance_transaction_recovery_version() RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE job_id TEXT;
BEGIN
    IF TG_TABLE_NAME = 'transaction_attempts' THEN job_id := NEW.delivery_job_id;
    ELSE
        EXECUTE format('SELECT delivery_job_id FROM %I.transaction_attempts WHERE attempt_id = $1',TG_TABLE_SCHEMA) INTO job_id USING NEW.attempt_id;
    END IF;
    -- Final intent version already records its atomic winner. Final sibling
    -- bookkeeping and journal completion do not reopen a terminal intent.
    EXECUTE format('UPDATE %I.transaction_intents SET recovery_version = recovery_version + 1 WHERE delivery_job_id = $1 AND status = ''PENDING''',TG_TABLE_SCHEMA) USING job_id;
    RETURN NEW;
END;
$guard$;
CREATE TRIGGER transaction_attempts_recovery_version AFTER INSERT OR UPDATE ON transaction_attempts
    FOR EACH ROW EXECUTE FUNCTION advance_transaction_recovery_version();
CREATE TRIGGER transaction_broadcast_events_recovery_version AFTER INSERT OR UPDATE ON transaction_broadcast_events
    FOR EACH ROW EXECUTE FUNCTION advance_transaction_recovery_version();
