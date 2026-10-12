-- Extend existing records in place. Never reconstruct or re-sign old artifacts.
ALTER TABLE transaction_intents DISABLE TRIGGER transaction_intents_guard;
ALTER TABLE transaction_attempts DISABLE TRIGGER transaction_attempts_guard;
ALTER TABLE transaction_intents ADD COLUMN nonce NUMERIC(78,0);
ALTER TABLE transaction_intents ADD COLUMN status TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE transaction_intents ADD COLUMN winning_attempt_id BIGINT;
ALTER TABLE transaction_intents ADD COLUMN next_action_at TIMESTAMPTZ;
ALTER TABLE transaction_intents ADD COLUMN retry_stopped_at TIMESTAMPTZ;
ALTER TABLE transaction_intents ADD COLUMN retry_stop_reason TEXT;
ALTER TABLE transaction_attempts ADD COLUMN replacement_of_attempt_id BIGINT;
ALTER TABLE transaction_attempts ADD COLUMN broadcast_attempt_count NUMERIC(78,0) NOT NULL DEFAULT 0;
ALTER TABLE transaction_attempts ADD COLUMN last_broadcast_attempt_at TIMESTAMPTZ;
ALTER TABLE transaction_attempts ADD COLUMN last_error_class TEXT;

DO $migration$
BEGIN
    IF EXISTS (SELECT 1 FROM transaction_intents i LEFT JOIN transaction_attempts a USING (delivery_job_id)
        WHERE a.attempt_id IS NULL OR a.attempt_number <> 0) THEN
        RAISE EXCEPTION 'transaction migration requires every existing intent to have its original attempt';
    END IF;
END;
$migration$;
UPDATE transaction_intents i SET nonce = a.nonce,
    status = CASE WHEN a.status IN ('CONFIRMED','REVERTED') THEN a.status ELSE 'PENDING' END,
    winning_attempt_id = CASE WHEN a.status IN ('CONFIRMED','REVERTED') THEN a.attempt_id END,
    next_action_at = CASE WHEN a.status IN ('CONFIRMED','REVERTED') THEN NULL ELSE COALESCE(a.broadcast_at,a.created_at) END
    FROM transaction_attempts a WHERE a.delivery_job_id = i.delivery_job_id;
-- Accepted/confirmed artifacts prove at least one send. SIGNED has no known
-- historical send count; retain zero and require exact-byte rebroadcast first.
UPDATE transaction_attempts SET broadcast_attempt_count = 1,last_broadcast_attempt_at = broadcast_at
    WHERE broadcast_at IS NOT NULL;

ALTER TABLE transaction_intents ALTER COLUMN nonce SET NOT NULL;
ALTER TABLE transaction_intents ADD CONSTRAINT transaction_intents_nonce_check CHECK (nonce >= 0 AND nonce < power(2::numeric,256));
ALTER TABLE transaction_intents ADD CONSTRAINT transaction_intents_sender_nonce_key UNIQUE (chain_id,sender_address,nonce);
ALTER TABLE transaction_intents ADD CONSTRAINT transaction_intents_attempt_context_key UNIQUE (delivery_job_id,chain_id,sender_address,nonce);
ALTER TABLE transaction_intents ADD CONSTRAINT transaction_intents_retry_state_check CHECK (
    status IN ('PENDING','CONFIRMED','REVERTED') AND
    ((retry_stopped_at IS NULL AND retry_stop_reason IS NULL) OR (retry_stopped_at IS NOT NULL AND retry_stop_reason IS NOT NULL)) AND
    ((status = 'PENDING' AND winning_attempt_id IS NULL AND
      ((retry_stopped_at IS NULL AND next_action_at IS NOT NULL) OR (retry_stopped_at IS NOT NULL AND next_action_at IS NULL))) OR
     (status IN ('CONFIRMED','REVERTED') AND winning_attempt_id IS NOT NULL AND next_action_at IS NULL))
);

ALTER TABLE transaction_attempts DROP CONSTRAINT transaction_attempts_delivery_job_id_key;
ALTER TABLE transaction_attempts DROP CONSTRAINT transaction_attempts_chain_id_sender_address_nonce_key;
-- Remove only old ordinal/status lifecycle CHECKs, whose generated names depend
-- on PostgreSQL naming. Keep nonce, fee, gas, hash and artifact constraints.
DO $migration$
DECLARE item RECORD; ordinal SMALLINT; state SMALLINT;
BEGIN
    SELECT attnum INTO ordinal FROM pg_attribute WHERE attrelid = 'transaction_attempts'::regclass AND attname = 'attempt_number';
    SELECT attnum INTO state FROM pg_attribute WHERE attrelid = 'transaction_attempts'::regclass AND attname = 'status';
    FOR item IN SELECT conname FROM pg_constraint WHERE conrelid = 'transaction_attempts'::regclass AND contype = 'c'
        AND (ordinal = ANY(conkey) OR state = ANY(conkey)) LOOP
        EXECUTE format('ALTER TABLE transaction_attempts DROP CONSTRAINT %I',item.conname);
    END LOOP;
END;
$migration$;
ALTER TABLE transaction_attempts ADD CONSTRAINT transaction_attempts_ordinal_check CHECK (attempt_number >= 0 AND attempt_number < 1000);
ALTER TABLE transaction_attempts ADD CONSTRAINT transaction_attempts_intent_ordinal_key UNIQUE (delivery_job_id,attempt_number);
ALTER TABLE transaction_attempts ADD CONSTRAINT transaction_attempts_intent_id_key UNIQUE (delivery_job_id,attempt_id);
ALTER TABLE transaction_attempts ADD CONSTRAINT transaction_attempts_parent_key UNIQUE (replacement_of_attempt_id);
ALTER TABLE transaction_attempts ADD CONSTRAINT transaction_attempts_parent_fk FOREIGN KEY (replacement_of_attempt_id) REFERENCES transaction_attempts (attempt_id);
ALTER TABLE transaction_attempts ADD CONSTRAINT transaction_attempts_intent_context_fk FOREIGN KEY (delivery_job_id,chain_id,sender_address,nonce)
    REFERENCES transaction_intents (delivery_job_id,chain_id,sender_address,nonce);
ALTER TABLE transaction_attempts ADD CONSTRAINT transaction_attempts_retry_metadata_check CHECK (
    broadcast_attempt_count >= 0 AND broadcast_attempt_count < power(2::numeric,256) AND
    ((broadcast_attempt_count = 0 AND last_broadcast_attempt_at IS NULL) OR (broadcast_attempt_count > 0 AND last_broadcast_attempt_at IS NOT NULL)) AND
    (last_error_class IS NULL OR last_error_class IN ('TRANSIENT_RPC_ERROR','AMBIGUOUS_BROADCAST','ALREADY_KNOWN','REPLACEMENT_UNDERPRICED','NONCE_TOO_LOW','DETERMINISTIC_REJECTION')) AND
    ((attempt_number = 0 AND replacement_of_attempt_id IS NULL) OR (attempt_number > 0 AND replacement_of_attempt_id IS NOT NULL))
);
ALTER TABLE transaction_attempts ADD CONSTRAINT transaction_attempts_lifecycle_check CHECK (
    status IN ('SIGNED','BROADCAST','REPLACED','CONFIRMED','REVERTED') AND
    ((status IN ('SIGNED','BROADCAST','REPLACED') AND receipt_block_number IS NULL AND receipt_block_hash IS NULL AND receipt_status IS NULL AND confirmed_head IS NULL AND confirmed_at IS NULL AND
       (status <> 'SIGNED' OR broadcast_at IS NULL) AND (status <> 'BROADCAST' OR broadcast_at IS NOT NULL)) OR
     (status IN ('CONFIRMED','REVERTED') AND broadcast_at IS NOT NULL AND receipt_block_number IS NOT NULL AND receipt_block_hash IS NOT NULL AND receipt_status IS NOT NULL AND confirmed_head IS NOT NULL AND confirmed_at IS NOT NULL AND
       ((status = 'CONFIRMED' AND receipt_status = 1) OR (status = 'REVERTED' AND receipt_status = 0))))
);
CREATE UNIQUE INDEX transaction_attempts_one_winner_idx ON transaction_attempts (delivery_job_id) WHERE status IN ('CONFIRMED','REVERTED');
ALTER TABLE transaction_intents ADD CONSTRAINT transaction_intents_winner_fk FOREIGN KEY (delivery_job_id,winning_attempt_id)
    REFERENCES transaction_attempts (delivery_job_id,attempt_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX transaction_intents_action_idx ON transaction_intents (chain_id,sender_address,next_action_at,delivery_job_id)
    WHERE status = 'PENDING' AND retry_stopped_at IS NULL;

CREATE OR REPLACE FUNCTION guard_transaction_intent() RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE job RECORD; historical BOOLEAN; winner RECORD;
BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'transaction intents are immutable'; END IF;
    IF TG_OP = 'INSERT' THEN
        EXECUTE format('SELECT * FROM %I.delivery_jobs WHERE delivery_job_id = $1',TG_TABLE_SCHEMA) INTO job USING NEW.delivery_job_id;
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.relayer_submissions WHERE delivery_job_id = $1)',TG_TABLE_SCHEMA) INTO historical USING NEW.delivery_job_id;
        IF historical THEN RAISE EXCEPTION 'historical direct submission already exists'; END IF;
        IF job.delivery_job_id IS NULL OR job.status IS DISTINCT FROM 'READY' OR NEW.status <> 'PENDING' OR
            ROW(NEW.chain_id,NEW.destination_gateway) IS DISTINCT FROM ROW(job.destination_domain,job.destination_gateway) THEN
            RAISE EXCEPTION 'transaction intent differs from canonical READY destination';
        END IF;
    ELSE
        IF ROW(NEW.delivery_job_id,NEW.package_digest,NEW.chain_id,NEW.sender_address,NEW.destination_gateway,NEW.value,NEW.calldata,NEW.nonce,NEW.created_at)
            IS DISTINCT FROM ROW(OLD.delivery_job_id,OLD.package_digest,OLD.chain_id,OLD.sender_address,OLD.destination_gateway,OLD.value,OLD.calldata,OLD.nonce,OLD.created_at) THEN
            RAISE EXCEPTION 'transaction intents are immutable';
        END IF;
        IF OLD.status <> 'PENDING' OR NEW.status NOT IN ('PENDING','CONFIRMED','REVERTED') THEN RAISE EXCEPTION 'illegal transaction intent status transition'; END IF;
        IF OLD.retry_stopped_at IS NOT NULL AND ROW(NEW.retry_stopped_at,NEW.retry_stop_reason) IS DISTINCT FROM ROW(OLD.retry_stopped_at,OLD.retry_stop_reason) THEN
            RAISE EXCEPTION 'automatic retry stop cannot be reset';
        END IF;
        IF NEW.status <> 'PENDING' THEN
            EXECUTE format('SELECT * FROM %I.transaction_attempts WHERE attempt_id = $1',TG_TABLE_SCHEMA) INTO winner USING NEW.winning_attempt_id;
            IF winner.delivery_job_id IS DISTINCT FROM NEW.delivery_job_id OR winner.status IS DISTINCT FROM NEW.status THEN
                RAISE EXCEPTION 'winning transaction attempt must belong to this intent and have its final outcome';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$guard$;

CREATE OR REPLACE FUNCTION guard_transaction_attempt() RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE intent RECORD; account RECORD; previous RECORD; latest INTEGER; child BOOLEAN;
BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'signed transaction attempts are immutable'; END IF;
    EXECUTE format('SELECT * FROM %I.transaction_intents WHERE delivery_job_id = $1 FOR UPDATE',TG_TABLE_SCHEMA) INTO intent USING NEW.delivery_job_id;
    IF TG_OP = 'INSERT' THEN
        EXECUTE format('SELECT * FROM %I.transaction_accounts WHERE chain_id = $1 AND sender_address = $2',TG_TABLE_SCHEMA) INTO account USING NEW.chain_id,NEW.sender_address;
        IF NEW.status <> 'SIGNED' OR intent.status IS DISTINCT FROM 'PENDING' OR intent.retry_stopped_at IS NOT NULL OR account.chain_id IS NULL OR
            ROW(NEW.chain_id,NEW.sender_address,NEW.nonce) IS DISTINCT FROM ROW(intent.chain_id,intent.sender_address,intent.nonce) OR account.next_nonce <= NEW.nonce THEN
            RAISE EXCEPTION 'SIGNED attempt requires a pending intent and its durable nonce';
        END IF;
        EXECUTE format('SELECT * FROM %I.transaction_attempts WHERE delivery_job_id = $1 ORDER BY attempt_number DESC LIMIT 1',TG_TABLE_SCHEMA) INTO previous USING NEW.delivery_job_id;
        IF NEW.attempt_number = 0 THEN
            IF previous.attempt_id IS NOT NULL THEN RAISE EXCEPTION 'initial transaction attempt already exists'; END IF;
        ELSE
            IF previous.attempt_id IS NULL OR previous.status NOT IN ('SIGNED','BROADCAST') OR
                NEW.attempt_number <> previous.attempt_number + 1 OR NEW.replacement_of_attempt_id IS DISTINCT FROM previous.attempt_id OR
                NEW.gas_limit <> previous.gas_limit OR NEW.max_fee_per_gas <= previous.max_fee_per_gas OR NEW.max_priority_fee_per_gas <= previous.max_priority_fee_per_gas THEN
                RAISE EXCEPTION 'replacement requires a linear next attempt with unchanged gas and strictly higher fees';
            END IF;
        END IF;
    ELSE
        IF ROW(NEW.attempt_id,NEW.delivery_job_id,NEW.attempt_number,NEW.replacement_of_attempt_id,NEW.chain_id,NEW.sender_address,NEW.nonce,NEW.gas_limit,NEW.max_fee_per_gas,NEW.max_priority_fee_per_gas,NEW.transaction_type,NEW.raw_signed_transaction,NEW.transaction_hash,NEW.created_at)
            IS DISTINCT FROM ROW(OLD.attempt_id,OLD.delivery_job_id,OLD.attempt_number,OLD.replacement_of_attempt_id,OLD.chain_id,OLD.sender_address,OLD.nonce,OLD.gas_limit,OLD.max_fee_per_gas,OLD.max_priority_fee_per_gas,OLD.transaction_type,OLD.raw_signed_transaction,OLD.transaction_hash,OLD.created_at) THEN
            RAISE EXCEPTION 'signed transaction fields are immutable';
        END IF;
        IF OLD.status IN ('CONFIRMED','REVERTED') OR NEW.broadcast_attempt_count < OLD.broadcast_attempt_count OR
            (OLD.broadcast_at IS NOT NULL AND NEW.broadcast_at IS DISTINCT FROM OLD.broadcast_at) THEN
            RAISE EXCEPTION 'illegal transaction status transition';
        END IF;
        IF NEW.status NOT IN ('CONFIRMED','REVERTED') THEN
            IF intent.status <> 'PENDING' AND NEW.status <> 'REPLACED' THEN RAISE EXCEPTION 'final intent cannot send another transaction'; END IF;
            IF NOT (NEW.status = OLD.status OR (OLD.status = 'SIGNED' AND NEW.status = 'BROADCAST') OR (OLD.status IN ('SIGNED','BROADCAST') AND NEW.status = 'REPLACED')) THEN
                RAISE EXCEPTION 'illegal transaction status transition';
            END IF;
            IF NEW.status = 'REPLACED' AND OLD.status <> 'REPLACED' THEN
                EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.transaction_attempts WHERE replacement_of_attempt_id = $1)',TG_TABLE_SCHEMA) INTO child USING NEW.attempt_id;
                IF NOT child AND NOT (intent.status IN ('CONFIRMED','REVERTED') AND intent.winning_attempt_id <> NEW.attempt_id) THEN
                    RAISE EXCEPTION 'REPLACED is local history and requires a child or a different canonical winner';
                END IF;
            END IF;
            IF NEW.broadcast_attempt_count > OLD.broadcast_attempt_count THEN
                EXECUTE format('SELECT MAX(attempt_number) FROM %I.transaction_attempts WHERE delivery_job_id = $1',TG_TABLE_SCHEMA) INTO latest USING NEW.delivery_job_id;
                IF intent.retry_stopped_at IS NOT NULL OR intent.status <> 'PENDING' OR NEW.attempt_number <> latest OR OLD.status = 'REPLACED' THEN
                    RAISE EXCEPTION 'only the active pending attempt can be broadcast';
                END IF;
            END IF;
        ELSIF intent.status <> 'PENDING' AND intent.winning_attempt_id IS DISTINCT FROM NEW.attempt_id THEN
            RAISE EXCEPTION 'a different canonical winner is already recorded';
        END IF;
    END IF;
    RETURN NEW;
END;
$guard$;
ALTER TABLE transaction_intents ENABLE TRIGGER transaction_intents_guard;
ALTER TABLE transaction_attempts ENABLE TRIGGER transaction_attempts_guard;
