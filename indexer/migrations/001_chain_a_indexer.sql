CREATE TABLE IF NOT EXISTS source_messages (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    message_id TEXT NOT NULL,
    version SMALLINT NOT NULL CHECK (version BETWEEN 0 AND 255),
    source_domain NUMERIC(78, 0) NOT NULL CHECK (source_domain >= 0),
    source_gateway TEXT NOT NULL,
    source_sender TEXT NOT NULL,
    destination_domain NUMERIC(78, 0) NOT NULL CHECK (destination_domain >= 0),
    destination_gateway TEXT NOT NULL,
    destination_receiver TEXT NOT NULL,
    nonce NUMERIC(78, 0) NOT NULL CHECK (nonce >= 0),
    payload BYTEA NOT NULL,
    payload_hash TEXT NOT NULL,
    deadline NUMERIC(78, 0) NOT NULL CHECK (deadline >= 0),
    source_block_number NUMERIC(78, 0) NOT NULL CHECK (source_block_number >= 0),
    source_block_hash TEXT NOT NULL,
    source_tx_hash TEXT NOT NULL,
    source_log_index NUMERIC(78, 0) NOT NULL CHECK (source_log_index >= 0),
    observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'OBSERVED' CHECK (status = 'OBSERVED')
);

CREATE TABLE IF NOT EXISTS indexer_cursors (
    chain_domain NUMERIC(78, 0) NOT NULL CHECK (chain_domain >= 0),
    source_gateway TEXT NOT NULL,
    next_block NUMERIC(78, 0) NOT NULL CHECK (next_block >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (chain_domain, source_gateway)
);
