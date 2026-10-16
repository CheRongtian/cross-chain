-- Mutable transport scheduling only. Existing jobs and signed history are untouched.
ALTER TABLE relayer_job_leases
    ADD COLUMN preparation_retry_at TIMESTAMPTZ,
    ADD COLUMN preparation_defer_reason TEXT,
    ADD CONSTRAINT relayer_preparation_defer_pair CHECK (
        (preparation_retry_at IS NULL) = (preparation_defer_reason IS NULL)
        AND (preparation_defer_reason IS NULL OR preparation_defer_reason = 'ESTIMATE_EXECUTION_REVERT')
    );

-- One bit per configured worker survives one-shot processes and session changes.
ALTER TABLE relayer_worker_ids
    ADD COLUMN preparation_deferred_turn BOOLEAN NOT NULL DEFAULT FALSE;

-- Any successful initial preparation clears the scheduling metadata in the
-- same commit, including direct manager preparation without an orchestration fence.
CREATE FUNCTION clear_relayer_preparation_defer() RETURNS trigger LANGUAGE plpgsql AS $clear$
BEGIN
    EXECUTE format('UPDATE %I.relayer_job_leases SET preparation_retry_at = NULL,
        preparation_defer_reason = NULL,updated_at = clock_timestamp()
        WHERE delivery_job_id = $1 AND preparation_retry_at IS NOT NULL',TG_TABLE_SCHEMA)
        USING NEW.delivery_job_id;
    RETURN NEW;
END;
$clear$;
CREATE TRIGGER transaction_intent_clears_preparation_defer AFTER INSERT ON transaction_intents
    FOR EACH ROW EXECUTE FUNCTION clear_relayer_preparation_defer();
