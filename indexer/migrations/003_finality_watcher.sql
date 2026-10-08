ALTER TABLE source_messages
    ADD COLUMN IF NOT EXISTS finalizing_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS finalized_at_head NUMERIC(78, 0) NULL;

ALTER TABLE source_messages
    DROP CONSTRAINT IF EXISTS source_messages_status_check;

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'source_messages_status_lifecycle_check'
          AND contype = 'c'
          AND conrelid = 'source_messages'::regclass
    ) THEN
        ALTER TABLE source_messages
            ADD CONSTRAINT source_messages_status_lifecycle_check
            CHECK (status IN ('OBSERVED', 'FINALIZING', 'FINALIZED'));
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'source_messages_finality_metadata_check'
          AND contype = 'c'
          AND conrelid = 'source_messages'::regclass
    ) THEN
        ALTER TABLE source_messages
            ADD CONSTRAINT source_messages_finality_metadata_check
            CHECK (
                (
                    status = 'OBSERVED'
                    AND finalizing_at IS NULL
                    AND finalized_at IS NULL
                    AND finalized_at_head IS NULL
                )
                OR (
                    status = 'FINALIZING'
                    AND finalizing_at IS NOT NULL
                    AND finalized_at IS NULL
                    AND finalized_at_head IS NULL
                )
                OR (
                    status = 'FINALIZED'
                    AND finalized_at IS NOT NULL
                    AND finalized_at_head IS NOT NULL
                )
            );
    END IF;
END
$migration$;

CREATE INDEX IF NOT EXISTS source_messages_finality_candidates_idx
    ON source_messages (
        source_domain,
        source_gateway,
        status,
        source_block_number,
        source_log_index
    );
