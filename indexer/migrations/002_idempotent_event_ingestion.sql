DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'source_messages_source_event_unique'
          AND contype = 'u'
          AND conrelid = 'source_messages'::regclass
    ) THEN
        IF EXISTS (
            SELECT 1
            FROM source_messages
            GROUP BY
                source_domain,
                source_gateway,
                source_block_hash,
                source_tx_hash,
                source_log_index
            HAVING COUNT(*) > 1
        ) THEN
            RAISE EXCEPTION
                'Cannot enable idempotent event ingestion: duplicate source event identities already exist.';
        END IF;

        ALTER TABLE source_messages
            ADD CONSTRAINT source_messages_source_event_unique
            UNIQUE (
                source_domain,
                source_gateway,
                source_block_hash,
                source_tx_hash,
                source_log_index
            );
    END IF;
END
$migration$;
