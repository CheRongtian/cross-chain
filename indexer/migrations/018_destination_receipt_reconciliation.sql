-- Several upgrades can share one transaction. Check the existing winner FK
-- immediately during backfill so no deferred events block the following DDL.
-- Restore its ordinary deferred mode after all schema changes are complete.
SET CONSTRAINTS transaction_intents_winner_fk IMMEDIATE;

-- Receipt columns on attempts are the current-outcome cache. Every terminal
-- observation is retained independently before that cache can be invalidated.
CREATE TABLE transaction_receipt_observations (
    observation_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    delivery_job_id TEXT NOT NULL,
    attempt_id BIGINT NOT NULL,
    transaction_hash TEXT NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
    block_number NUMERIC(78,0) NOT NULL CHECK (block_number >= 0),
    block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
    receipt_status SMALLINT NOT NULL CHECK (receipt_status IN (0,1)),
    confirmed_head NUMERIC(78,0) NOT NULL CHECK (confirmed_head >= block_number),
    confirmed_at TIMESTAMPTZ NOT NULL,
    UNIQUE (delivery_job_id,observation_id),
    FOREIGN KEY (delivery_job_id,attempt_id) REFERENCES transaction_attempts (delivery_job_id,attempt_id)
);
CREATE TABLE transaction_receipt_orphans (
    reorg_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    observation_id BIGINT NOT NULL UNIQUE REFERENCES transaction_receipt_observations (observation_id),
    replacement_block_hash TEXT NOT NULL CHECK (replacement_block_hash ~ '^0x[0-9a-f]{64}$'),
    observed_head NUMERIC(78,0) NOT NULL CHECK (observed_head >= 0),
    observed_head_hash TEXT NOT NULL CHECK (observed_head_hash ~ '^0x[0-9a-f]{64}$'),
    expected_version BIGINT NOT NULL CHECK (expected_version >= 0),
    reconciled_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    reconciliation_xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
ALTER TABLE transaction_accounts ADD COLUMN terminal_scan_cursor_nonce NUMERIC(78,0)
    CHECK (terminal_scan_cursor_nonce >= 0 AND terminal_scan_cursor_nonce < power(2::numeric,256));
ALTER TABLE transaction_intents
    ADD COLUMN current_receipt_observation_id BIGINT,
    ADD COLUMN destination_reorg_id BIGINT REFERENCES transaction_receipt_orphans (reorg_id),
    ADD COLUMN reorg_rebroadcast_required BOOLEAN NOT NULL DEFAULT false,
    ADD FOREIGN KEY (delivery_job_id,current_receipt_observation_id)
        REFERENCES transaction_receipt_observations (delivery_job_id,observation_id);

-- Backfill only the new observation/pointer, leaving all old artifacts,
-- terminal states, recovery revisions and timestamps exactly as they were.
INSERT INTO transaction_receipt_observations (delivery_job_id,attempt_id,transaction_hash,block_number,block_hash,receipt_status,confirmed_head,confirmed_at)
    SELECT delivery_job_id,attempt_id,transaction_hash,receipt_block_number,receipt_block_hash,receipt_status,confirmed_head,confirmed_at
    FROM transaction_attempts WHERE status IN ('CONFIRMED','REVERTED');
ALTER TABLE transaction_intents DISABLE TRIGGER transaction_intents_guard;
ALTER TABLE transaction_intents DISABLE TRIGGER a_transaction_recovery_fields;
UPDATE transaction_intents i SET current_receipt_observation_id = o.observation_id
    FROM transaction_receipt_observations o WHERE i.delivery_job_id = o.delivery_job_id AND i.winning_attempt_id = o.attempt_id;
ALTER TABLE transaction_intents ENABLE TRIGGER a_transaction_recovery_fields;
ALTER TABLE transaction_intents ENABLE TRIGGER transaction_intents_guard;
ALTER TABLE transaction_intents ADD CONSTRAINT transaction_intents_current_receipt_check CHECK (
    (status = 'PENDING' AND current_receipt_observation_id IS NULL) OR
    (status IN ('CONFIRMED','REVERTED') AND current_receipt_observation_id IS NOT NULL AND NOT reorg_rebroadcast_required)
);
CREATE INDEX transaction_intents_terminal_scan_idx ON transaction_intents (chain_id,sender_address,nonce,delivery_job_id)
    WHERE status IN ('CONFIRMED','REVERTED');
CREATE INDEX transaction_receipt_observations_job_idx ON transaction_receipt_observations (delivery_job_id,observation_id);

CREATE FUNCTION guard_destination_receipt_history() RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE a RECORD; o RECORD; i RECORD;
BEGIN
    IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'destination receipt history is append-only'; END IF;
    IF TG_TABLE_NAME = 'transaction_receipt_observations' THEN
        EXECUTE format('SELECT * FROM %I.transaction_attempts WHERE attempt_id = $1',TG_TABLE_SCHEMA) INTO a USING NEW.attempt_id;
        IF a.status NOT IN ('CONFIRMED','REVERTED') OR
            ROW(NEW.delivery_job_id,NEW.transaction_hash,NEW.block_number,NEW.block_hash,NEW.receipt_status,NEW.confirmed_head,NEW.confirmed_at)
            IS DISTINCT FROM ROW(a.delivery_job_id,a.transaction_hash,a.receipt_block_number,a.receipt_block_hash,a.receipt_status,a.confirmed_head,a.confirmed_at) THEN
            RAISE EXCEPTION 'receipt history requires the exact persisted terminal observation';
        END IF;
    ELSE
        EXECUTE format('SELECT * FROM %I.transaction_receipt_observations WHERE observation_id = $1',TG_TABLE_SCHEMA) INTO o USING NEW.observation_id;
        EXECUTE format('SELECT * FROM %I.transaction_intents WHERE delivery_job_id = $1 FOR UPDATE',TG_TABLE_SCHEMA) INTO i USING o.delivery_job_id;
        IF i.current_receipt_observation_id IS DISTINCT FROM NEW.observation_id OR i.status NOT IN ('CONFIRMED','REVERTED') OR
            NEW.replacement_block_hash = o.block_hash OR NEW.observed_head < o.block_number OR
            NEW.expected_version IS DISTINCT FROM i.recovery_version OR NEW.reconciliation_xid IS DISTINCT FROM pg_current_xact_id() THEN
            RAISE EXCEPTION 'orphan evidence requires a current terminal observation and positive canonical replacement';
        END IF;
    END IF;
    RETURN NEW;
END;
$guard$;
CREATE TRIGGER transaction_receipt_observations_guard BEFORE INSERT OR UPDATE OR DELETE ON transaction_receipt_observations
    FOR EACH ROW EXECUTE FUNCTION guard_destination_receipt_history();
CREATE TRIGGER transaction_receipt_orphans_guard BEFORE INSERT OR UPDATE OR DELETE ON transaction_receipt_orphans
    FOR EACH ROW EXECUTE FUNCTION guard_destination_receipt_history();

CREATE FUNCTION archive_destination_receipt() RETURNS trigger LANGUAGE plpgsql AS $archive$
BEGIN
    EXECUTE format('INSERT INTO %I.transaction_receipt_observations (delivery_job_id,attempt_id,transaction_hash,block_number,block_hash,receipt_status,confirmed_head,confirmed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',TG_TABLE_SCHEMA)
        USING NEW.delivery_job_id,NEW.attempt_id,NEW.transaction_hash,NEW.receipt_block_number,NEW.receipt_block_hash,NEW.receipt_status,NEW.confirmed_head,NEW.confirmed_at;
    RETURN NEW;
END;
$archive$;
CREATE TRIGGER transaction_attempts_archive_receipt AFTER UPDATE ON transaction_attempts
    FOR EACH ROW WHEN (NEW.status IN ('CONFIRMED','REVERTED') AND OLD.status NOT IN ('CONFIRMED','REVERTED'))
    EXECUTE FUNCTION archive_destination_receipt();

-- Keep the existing ordinary guards intact. Only the narrowly defined reorg
-- transitions are routed through the additional evidence-checking guard.
DROP TRIGGER transaction_intents_guard ON transaction_intents;
CREATE TRIGGER transaction_intents_guard BEFORE UPDATE ON transaction_intents
    FOR EACH ROW WHEN (NOT (OLD.status IN ('CONFIRMED','REVERTED') AND NEW.status = 'PENDING'))
    EXECUTE FUNCTION guard_transaction_intent();
CREATE TRIGGER transaction_intents_identity_guard BEFORE INSERT OR DELETE ON transaction_intents
    FOR EACH ROW EXECUTE FUNCTION guard_transaction_intent();
DROP TRIGGER transaction_attempts_guard ON transaction_attempts;
CREATE TRIGGER transaction_attempts_guard BEFORE UPDATE ON transaction_attempts
    FOR EACH ROW WHEN (NOT (OLD.status IN ('CONFIRMED','REVERTED','REPLACED') AND NEW.status IN ('SIGNED','BROADCAST','REPLACED') AND OLD.status <> NEW.status))
    EXECUTE FUNCTION guard_transaction_attempt();
CREATE TRIGGER transaction_attempts_identity_guard BEFORE INSERT OR DELETE ON transaction_attempts
    FOR EACH ROW EXECUTE FUNCTION guard_transaction_attempt();

CREATE FUNCTION guard_destination_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE i RECORD; p RECORD; o RECORD; a RECORD; invalid BOOLEAN; latest INTEGER;
BEGIN
    IF TG_TABLE_NAME = 'transaction_intents' THEN
        IF OLD.status IN ('CONFIRMED','REVERTED') AND NEW.status = 'PENDING' THEN
            EXECUTE format('SELECT * FROM %I.transaction_receipt_orphans WHERE reorg_id = $1',TG_TABLE_SCHEMA) INTO p USING NEW.destination_reorg_id;
            IF p.observation_id IS DISTINCT FROM OLD.current_receipt_observation_id OR p.expected_version IS DISTINCT FROM OLD.recovery_version OR
                p.reconciliation_xid IS DISTINCT FROM pg_current_xact_id() OR NEW.winning_attempt_id IS NOT NULL OR
                NEW.current_receipt_observation_id IS NOT NULL OR NOT NEW.reorg_rebroadcast_required OR
                ROW(NEW.delivery_job_id,NEW.package_digest,NEW.chain_id,NEW.sender_address,NEW.destination_gateway,NEW.value,NEW.calldata,NEW.nonce,NEW.created_at,
                    NEW.retry_stopped_at,NEW.retry_stop_reason)
                IS DISTINCT FROM ROW(OLD.delivery_job_id,OLD.package_digest,OLD.chain_id,OLD.sender_address,OLD.destination_gateway,OLD.value,OLD.calldata,OLD.nonce,OLD.created_at,
                    OLD.retry_stopped_at,OLD.retry_stop_reason) THEN
                RAISE EXCEPTION 'illegal transaction intent status transition: dedicated proven-reorg reconciliation required';
            END IF;
        ELSE
            IF NEW.destination_reorg_id IS DISTINCT FROM OLD.destination_reorg_id OR
                (NEW.reorg_rebroadcast_required AND NOT OLD.reorg_rebroadcast_required) THEN
                RAISE EXCEPTION 'reorg identity requires dedicated proven-reorg reconciliation';
            END IF;
            IF NEW.status IN ('CONFIRMED','REVERTED') THEN
                EXECUTE format('SELECT * FROM %I.transaction_receipt_observations WHERE observation_id = $1',TG_TABLE_SCHEMA) INTO o USING NEW.current_receipt_observation_id;
                EXECUTE format('SELECT * FROM %I.transaction_attempts WHERE attempt_id = $1',TG_TABLE_SCHEMA) INTO a USING NEW.winning_attempt_id;
                EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.transaction_receipt_orphans WHERE observation_id = $1)',TG_TABLE_SCHEMA) INTO invalid USING NEW.current_receipt_observation_id;
                IF o.delivery_job_id IS DISTINCT FROM NEW.delivery_job_id OR o.attempt_id IS DISTINCT FROM NEW.winning_attempt_id OR
                    invalid OR o.receipt_status IS DISTINCT FROM (CASE WHEN NEW.status = 'CONFIRMED' THEN 1 ELSE 0 END) OR
                    ROW(o.transaction_hash,o.block_number,o.block_hash,o.receipt_status,o.confirmed_head,o.confirmed_at)
                    IS DISTINCT FROM ROW(a.transaction_hash,a.receipt_block_number,a.receipt_block_hash,a.receipt_status,a.confirmed_head,a.confirmed_at) THEN
                    RAISE EXCEPTION 'current outcome requires its exact receipt observation';
                END IF;
            END IF;
        END IF;
    ELSE
        IF OLD.status IN ('CONFIRMED','REVERTED','REPLACED') AND NEW.status IN ('SIGNED','BROADCAST','REPLACED') AND OLD.status <> NEW.status THEN
            EXECUTE format('SELECT * FROM %I.transaction_intents WHERE delivery_job_id = $1 FOR UPDATE',TG_TABLE_SCHEMA) INTO i USING NEW.delivery_job_id;
            EXECUTE format('SELECT * FROM %I.transaction_receipt_orphans WHERE reorg_id = $1',TG_TABLE_SCHEMA) INTO p USING i.destination_reorg_id;
            EXECUTE format('SELECT * FROM %I.transaction_receipt_observations WHERE observation_id = $1',TG_TABLE_SCHEMA) INTO o USING p.observation_id;
            EXECUTE format('SELECT MAX(attempt_number) FROM %I.transaction_attempts WHERE delivery_job_id = $1',TG_TABLE_SCHEMA) INTO latest USING NEW.delivery_job_id;
            IF i.status IS DISTINCT FROM 'PENDING' OR p.reconciliation_xid IS DISTINCT FROM pg_current_xact_id() OR
                o.delivery_job_id IS DISTINCT FROM NEW.delivery_job_id OR NOT i.reorg_rebroadcast_required OR
                (OLD.status IN ('CONFIRMED','REVERTED') AND o.attempt_id IS DISTINCT FROM OLD.attempt_id) OR
                NEW.status IS DISTINCT FROM (CASE WHEN NEW.attempt_number < latest THEN 'REPLACED'
                    WHEN NEW.broadcast_at IS NULL THEN 'SIGNED' ELSE 'BROADCAST' END) OR
                ROW(NEW.receipt_block_number,NEW.receipt_block_hash,NEW.receipt_status,NEW.confirmed_head,NEW.confirmed_at) IS DISTINCT FROM ROW(NULL::numeric,NULL::text,NULL::smallint,NULL::numeric,NULL::timestamptz) OR
                ROW(NEW.attempt_id,NEW.delivery_job_id,NEW.attempt_number,NEW.replacement_of_attempt_id,NEW.chain_id,NEW.sender_address,NEW.nonce,NEW.gas_limit,
                    NEW.max_fee_per_gas,NEW.max_priority_fee_per_gas,NEW.transaction_type,NEW.raw_signed_transaction,NEW.transaction_hash,NEW.created_at,
                    NEW.broadcast_at,NEW.broadcast_attempt_count,NEW.last_broadcast_attempt_at,NEW.last_error_class)
                IS DISTINCT FROM ROW(OLD.attempt_id,OLD.delivery_job_id,OLD.attempt_number,OLD.replacement_of_attempt_id,OLD.chain_id,OLD.sender_address,OLD.nonce,OLD.gas_limit,
                    OLD.max_fee_per_gas,OLD.max_priority_fee_per_gas,OLD.transaction_type,OLD.raw_signed_transaction,OLD.transaction_hash,OLD.created_at,
                    OLD.broadcast_at,OLD.broadcast_attempt_count,OLD.last_broadcast_attempt_at,OLD.last_error_class) THEN
                RAISE EXCEPTION 'illegal transaction status transition: exact archived receipt and reorg evidence required';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$guard$;
CREATE TRIGGER transaction_intents_reorg_guard BEFORE UPDATE ON transaction_intents
    FOR EACH ROW EXECUTE FUNCTION guard_destination_reconciliation();
CREATE TRIGGER transaction_attempts_reorg_guard BEFORE UPDATE ON transaction_attempts
    FOR EACH ROW EXECUTE FUNCTION guard_destination_reconciliation();

SET CONSTRAINTS transaction_intents_winner_fk DEFERRED;
