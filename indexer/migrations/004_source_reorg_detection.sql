ALTER TABLE source_messages
    ADD COLUMN IF NOT EXISTS reorged_at TIMESTAMPTZ NULL;

ALTER TABLE source_messages
    DROP CONSTRAINT IF EXISTS source_messages_status_lifecycle_check,
    DROP CONSTRAINT IF EXISTS source_messages_finality_metadata_check;

ALTER TABLE source_messages
    ADD CONSTRAINT source_messages_status_lifecycle_check
        CHECK (status IN ('OBSERVED', 'FINALIZING', 'FINALIZED', 'REORGED')),
    ADD CONSTRAINT source_messages_finality_metadata_check
        CHECK (
            (
                status = 'OBSERVED'
                AND finalizing_at IS NULL
                AND finalized_at IS NULL
                AND finalized_at_head IS NULL
                AND reorged_at IS NULL
            )
            OR (
                status = 'FINALIZING'
                AND finalizing_at IS NOT NULL
                AND finalized_at IS NULL
                AND finalized_at_head IS NULL
                AND reorged_at IS NULL
            )
            OR (
                status = 'FINALIZED'
                AND finalized_at IS NOT NULL
                AND finalized_at_head IS NOT NULL
                AND reorged_at IS NULL
            )
            OR (
                status = 'REORGED'
                AND finalized_at IS NULL
                AND finalized_at_head IS NULL
                AND reorged_at IS NOT NULL
            )
        );

CREATE TABLE IF NOT EXISTS indexed_source_blocks (
    source_domain NUMERIC(78, 0) NOT NULL CHECK (source_domain >= 0),
    source_gateway TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL CHECK (block_number >= 0),
    block_hash TEXT NOT NULL,
    parent_hash TEXT NOT NULL,
    indexed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (source_domain, source_gateway, block_number)
);

CREATE INDEX IF NOT EXISTS source_messages_reorg_candidates_idx
    ON source_messages (
        source_domain,
        source_gateway,
        source_block_number,
        status
    );
