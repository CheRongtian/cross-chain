-- Retain all historical classes; separate unclassified/malformed provider
-- responses from evidence that a transaction was deterministically rejected.
-- No signed artifacts, journal results, schedules or nonce rows are rewritten.
ALTER TABLE transaction_attempts DROP CONSTRAINT transaction_attempts_retry_metadata_check;
ALTER TABLE transaction_attempts ADD CONSTRAINT transaction_attempts_retry_metadata_check CHECK (
    broadcast_attempt_count >= 0 AND broadcast_attempt_count < power(2::numeric,256) AND
    ((broadcast_attempt_count = 0 AND last_broadcast_attempt_at IS NULL) OR (broadcast_attempt_count > 0 AND last_broadcast_attempt_at IS NOT NULL)) AND
    (last_error_class IS NULL OR last_error_class IN ('TRANSIENT_RPC_ERROR','AMBIGUOUS_BROADCAST','ALREADY_KNOWN',
        'REPLACEMENT_UNDERPRICED','NONCE_TOO_LOW','DETERMINISTIC_REJECTION','RPC_RESPONSE_ERROR')) AND
    ((attempt_number = 0 AND replacement_of_attempt_id IS NULL) OR (attempt_number > 0 AND replacement_of_attempt_id IS NOT NULL))
);

ALTER TABLE transaction_broadcast_events DROP CONSTRAINT transaction_broadcast_events_error_class_check;
ALTER TABLE transaction_broadcast_events ADD CONSTRAINT transaction_broadcast_events_error_class_check CHECK (
    error_class IN ('TRANSIENT_RPC_ERROR','AMBIGUOUS_BROADCAST','ALREADY_KNOWN',
        'REPLACEMENT_UNDERPRICED','NONCE_TOO_LOW','DETERMINISTIC_REJECTION','RPC_RESPONSE_ERROR')
);
