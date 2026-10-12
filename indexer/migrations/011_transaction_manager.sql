CREATE TABLE transaction_accounts (
    chain_id NUMERIC(78,0) NOT NULL CHECK (chain_id > 0 AND chain_id < power(2::numeric,256)),
    sender_address TEXT NOT NULL CHECK (sender_address ~ '^0x[0-9a-f]{40}$'),
    next_nonce NUMERIC(78,0) NOT NULL CHECK (next_nonce >= 0 AND next_nonce < power(2::numeric,256)),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (chain_id,sender_address)
);

-- The existing delivery job identity is also the logical intent identity.
CREATE TABLE transaction_intents (
    delivery_job_id TEXT PRIMARY KEY REFERENCES delivery_jobs (delivery_job_id),
    package_digest TEXT NOT NULL CHECK (package_digest ~ '^0x[0-9a-f]{64}$'),
    chain_id NUMERIC(78,0) NOT NULL,
    sender_address TEXT NOT NULL,
    destination_gateway TEXT NOT NULL CHECK (destination_gateway ~ '^0x[0-9a-f]{40}$'),
    value NUMERIC(78,0) NOT NULL CHECK (value = 0),
    calldata TEXT NOT NULL CHECK (calldata ~ '^0x([0-9a-f]{2})+$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chain_id,sender_address) REFERENCES transaction_accounts (chain_id,sender_address)
);

CREATE TABLE transaction_attempts (
    attempt_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    delivery_job_id TEXT NOT NULL UNIQUE REFERENCES transaction_intents (delivery_job_id),
    attempt_number SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_number = 0),
    chain_id NUMERIC(78,0) NOT NULL,
    sender_address TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('SIGNED','BROADCAST','CONFIRMED','REVERTED')),
    nonce NUMERIC(78,0) NOT NULL CHECK (nonce >= 0 AND nonce < power(2::numeric,256)),
    gas_limit NUMERIC(78,0) NOT NULL CHECK (gas_limit > 0 AND gas_limit < power(2::numeric,256)),
    max_fee_per_gas NUMERIC(78,0) NOT NULL CHECK (max_fee_per_gas >= 0 AND max_fee_per_gas < power(2::numeric,256)),
    max_priority_fee_per_gas NUMERIC(78,0) NOT NULL CHECK (max_priority_fee_per_gas >= 0 AND max_priority_fee_per_gas <= max_fee_per_gas),
    transaction_type SMALLINT NOT NULL CHECK (transaction_type = 2),
    raw_signed_transaction TEXT NOT NULL CHECK (raw_signed_transaction ~ '^0x02([0-9a-f]{2})+$'),
    transaction_hash TEXT NOT NULL UNIQUE CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
    broadcast_at TIMESTAMPTZ,
    receipt_block_number NUMERIC(78,0) CHECK (receipt_block_number >= 0 AND receipt_block_number < power(2::numeric,256)),
    receipt_block_hash TEXT CHECK (receipt_block_hash ~ '^0x[0-9a-f]{64}$'),
    receipt_status SMALLINT CHECK (receipt_status IN (0,1)),
    confirmed_head NUMERIC(78,0) CHECK (confirmed_head >= receipt_block_number AND confirmed_head < power(2::numeric,256)),
    confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (chain_id,sender_address,nonce),
    FOREIGN KEY (chain_id,sender_address) REFERENCES transaction_accounts (chain_id,sender_address),
    CHECK (
      (status = 'SIGNED' AND broadcast_at IS NULL AND receipt_block_number IS NULL AND receipt_block_hash IS NULL AND receipt_status IS NULL AND confirmed_head IS NULL AND confirmed_at IS NULL) OR
      (status = 'BROADCAST' AND broadcast_at IS NOT NULL AND receipt_block_number IS NULL AND receipt_block_hash IS NULL AND receipt_status IS NULL AND confirmed_head IS NULL AND confirmed_at IS NULL) OR
      (status IN ('CONFIRMED','REVERTED') AND broadcast_at IS NOT NULL AND receipt_block_number IS NOT NULL AND receipt_block_hash IS NOT NULL AND receipt_status IS NOT NULL AND confirmed_head IS NOT NULL AND confirmed_at IS NOT NULL AND
        ((status = 'CONFIRMED' AND receipt_status = 1) OR (status = 'REVERTED' AND receipt_status = 0)))
    )
);
CREATE INDEX transaction_attempts_tracking_idx ON transaction_attempts (chain_id,sender_address,status,nonce,attempt_id);

CREATE FUNCTION guard_transaction_account() RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'transaction account allocation history is immutable'; END IF;
    IF TG_OP = 'UPDATE' AND (ROW(NEW.chain_id,NEW.sender_address,NEW.created_at) IS DISTINCT FROM ROW(OLD.chain_id,OLD.sender_address,OLD.created_at) OR NEW.next_nonce < OLD.next_nonce) THEN
        RAISE EXCEPTION 'transaction account identity is immutable and nonce state cannot regress';
    END IF;
    RETURN NEW;
END;
$guard$;
CREATE TRIGGER transaction_accounts_guard BEFORE UPDATE OR DELETE ON transaction_accounts
    FOR EACH ROW EXECUTE FUNCTION guard_transaction_account();

CREATE FUNCTION guard_transaction_intent() RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE job RECORD; historical BOOLEAN;
BEGIN
    IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'transaction intents are immutable'; END IF;
    EXECUTE format('SELECT * FROM %I.delivery_jobs WHERE delivery_job_id = $1',TG_TABLE_SCHEMA) INTO job USING NEW.delivery_job_id;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.relayer_submissions WHERE delivery_job_id = $1)',TG_TABLE_SCHEMA) INTO historical USING NEW.delivery_job_id;
    IF historical THEN RAISE EXCEPTION 'historical direct submission already exists'; END IF;
    IF job.delivery_job_id IS NULL OR job.status IS DISTINCT FROM 'READY' OR
        ROW(NEW.chain_id,NEW.destination_gateway) IS DISTINCT FROM ROW(job.destination_domain,job.destination_gateway) THEN
        RAISE EXCEPTION 'transaction intent differs from canonical READY destination';
    END IF;
    RETURN NEW;
END;
$guard$;
CREATE TRIGGER transaction_intents_guard BEFORE INSERT OR UPDATE OR DELETE ON transaction_intents
    FOR EACH ROW EXECUTE FUNCTION guard_transaction_intent();

CREATE FUNCTION guard_transaction_attempt() RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE intent RECORD; account RECORD;
BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'signed transaction attempts are immutable'; END IF;
    IF TG_OP = 'INSERT' THEN
        EXECUTE format('SELECT * FROM %I.transaction_intents WHERE delivery_job_id = $1',TG_TABLE_SCHEMA) INTO intent USING NEW.delivery_job_id;
        EXECUTE format('SELECT * FROM %I.transaction_accounts WHERE chain_id = $1 AND sender_address = $2',TG_TABLE_SCHEMA) INTO account USING NEW.chain_id,NEW.sender_address;
        IF NEW.status <> 'SIGNED' OR intent.delivery_job_id IS NULL OR account.chain_id IS NULL OR
            ROW(NEW.chain_id,NEW.sender_address) IS DISTINCT FROM ROW(intent.chain_id,intent.sender_address) OR account.next_nonce <= NEW.nonce THEN
            RAISE EXCEPTION 'SIGNED attempt requires a matching intent and durable nonce allocation';
        END IF;
    ELSE
        IF ROW(NEW.attempt_id,NEW.delivery_job_id,NEW.attempt_number,NEW.chain_id,NEW.sender_address,NEW.nonce,NEW.gas_limit,NEW.max_fee_per_gas,NEW.max_priority_fee_per_gas,NEW.transaction_type,NEW.raw_signed_transaction,NEW.transaction_hash,NEW.created_at)
            IS DISTINCT FROM ROW(OLD.attempt_id,OLD.delivery_job_id,OLD.attempt_number,OLD.chain_id,OLD.sender_address,OLD.nonce,OLD.gas_limit,OLD.max_fee_per_gas,OLD.max_priority_fee_per_gas,OLD.transaction_type,OLD.raw_signed_transaction,OLD.transaction_hash,OLD.created_at) THEN
            RAISE EXCEPTION 'signed transaction fields are immutable';
        END IF;
        IF NOT ((OLD.status = 'SIGNED' AND NEW.status = 'BROADCAST') OR (OLD.status = 'BROADCAST' AND NEW.status IN ('CONFIRMED','REVERTED'))) THEN
            RAISE EXCEPTION 'illegal transaction status transition';
        END IF;
        IF OLD.broadcast_at IS NOT NULL AND NEW.broadcast_at IS DISTINCT FROM OLD.broadcast_at THEN
            RAISE EXCEPTION 'broadcast timestamp is immutable';
        END IF;
    END IF;
    RETURN NEW;
END;
$guard$;
CREATE TRIGGER transaction_attempts_guard BEFORE INSERT OR UPDATE OR DELETE ON transaction_attempts
    FOR EACH ROW EXECUTE FUNCTION guard_transaction_attempt();
