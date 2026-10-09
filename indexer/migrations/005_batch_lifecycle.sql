CREATE TABLE IF NOT EXISTS message_batches (
    batch_record_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_domain NUMERIC(78, 0) NOT NULL,
    source_gateway TEXT NOT NULL,
    epoch NUMERIC(78, 0) NOT NULL CHECK (
        epoch >= 0 AND epoch < 115792089237316195423570985008687907853269984665640564039457584007913129639936
    ),
    status TEXT NOT NULL DEFAULT 'BUILDING'
        CHECK (status IN ('BUILDING', 'SEALED', 'CONSENSUS_PENDING', 'COMMITTED')),
    version SMALLINT NOT NULL DEFAULT 1 CHECK (version = 1),
    batch_id TEXT NULL UNIQUE CHECK (batch_id ~ '^0x[0-9a-f]{64}$'),
    message_root TEXT NULL CHECK (message_root ~ '^0x[0-9a-f]{64}$'),
    message_count BIGINT NULL CHECK (message_count > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sealed_at TIMESTAMPTZ NULL,
    consensus_pending_at TIMESTAMPTZ NULL,
    committed_at TIMESTAMPTZ NULL,
    UNIQUE (source_domain, source_gateway, epoch),
    FOREIGN KEY (source_domain, source_gateway)
        REFERENCES indexer_cursors (chain_domain, source_gateway),
    CHECK (
        (status = 'BUILDING' AND batch_id IS NULL AND message_root IS NULL
            AND message_count IS NULL AND sealed_at IS NULL
            AND consensus_pending_at IS NULL AND committed_at IS NULL)
        OR
        (status = 'SEALED' AND batch_id IS NOT NULL AND message_root IS NOT NULL
            AND message_count IS NOT NULL AND sealed_at IS NOT NULL
            AND consensus_pending_at IS NULL AND committed_at IS NULL)
        OR
        (status = 'CONSENSUS_PENDING' AND batch_id IS NOT NULL AND message_root IS NOT NULL
            AND message_count IS NOT NULL AND sealed_at IS NOT NULL
            AND consensus_pending_at IS NOT NULL AND committed_at IS NULL)
        OR
        (status = 'COMMITTED' AND batch_id IS NOT NULL AND message_root IS NOT NULL
            AND message_count IS NOT NULL AND sealed_at IS NOT NULL
            AND consensus_pending_at IS NOT NULL AND committed_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS message_batches_one_building_per_scope_idx
    ON message_batches (source_domain, source_gateway)
    WHERE status = 'BUILDING';

CREATE TABLE IF NOT EXISTS message_batch_members (
    batch_record_id BIGINT NOT NULL REFERENCES message_batches (batch_record_id),
    source_message_id BIGINT NOT NULL UNIQUE REFERENCES source_messages (id),
    message_id TEXT NOT NULL CHECK (message_id ~ '^0x[0-9a-f]{64}$'),
    canonical_position BIGINT NULL CHECK (canonical_position >= 0),
    PRIMARY KEY (batch_record_id, source_message_id),
    UNIQUE (batch_record_id, message_id),
    UNIQUE (batch_record_id, canonical_position)
);

CREATE OR REPLACE FUNCTION guard_message_batch_record()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
    cursor_value NUMERIC;
    previous_epoch NUMERIC;
    membership RECORD;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'BUILDING' THEN
            RAISE EXCEPTION 'new lifecycle batches must start BUILDING';
        END IF;
        EXECUTE format(
            'SELECT next_block FROM %I.indexer_cursors
             WHERE chain_domain = $1 AND source_gateway = $2 FOR UPDATE', TG_TABLE_SCHEMA
        ) INTO cursor_value USING NEW.source_domain, NEW.source_gateway;
        IF cursor_value IS NULL THEN
            RAISE EXCEPTION 'source cursor is required before creating a lifecycle batch';
        END IF;
        EXECUTE format(
            'SELECT MAX(epoch) FROM %I.message_batches
             WHERE source_domain = $1 AND source_gateway = $2', TG_TABLE_SCHEMA
        ) INTO previous_epoch USING NEW.source_domain, NEW.source_gateway;
        IF previous_epoch IS NOT NULL AND NEW.epoch <> previous_epoch + 1 THEN
            RAISE EXCEPTION 'next batch epoch must increment the persisted epoch exactly once';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'BUILDING' THEN
            RAISE EXCEPTION 'sealed lifecycle batch records cannot be deleted';
        END IF;
        RETURN OLD;
    END IF;

    IF ROW(NEW.batch_record_id, NEW.source_domain, NEW.source_gateway, NEW.epoch, NEW.version, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.batch_record_id, OLD.source_domain, OLD.source_gateway, OLD.epoch, OLD.version, OLD.created_at) THEN
        RAISE EXCEPTION 'batch record identity, scope, epoch, and version are immutable';
    END IF;
    IF OLD.status <> 'BUILDING' AND
       ROW(NEW.batch_id, NEW.message_root, NEW.message_count)
       IS DISTINCT FROM ROW(OLD.batch_id, OLD.message_root, OLD.message_count) THEN
        RAISE EXCEPTION 'sealed batch commitment is immutable';
    END IF;
    IF (OLD.sealed_at IS NOT NULL AND NEW.sealed_at IS DISTINCT FROM OLD.sealed_at)
       OR (OLD.consensus_pending_at IS NOT NULL AND NEW.consensus_pending_at IS DISTINCT FROM OLD.consensus_pending_at)
       OR (OLD.committed_at IS NOT NULL AND NEW.committed_at IS DISTINCT FROM OLD.committed_at) THEN
        RAISE EXCEPTION 'persisted batch transition timestamps cannot be rewritten';
    END IF;
    IF NEW.status = 'COMMITTED' AND OLD.status <> 'COMMITTED' THEN
        RAISE EXCEPTION 'COMMITTED requires future PBFT quorum authorization; transition unavailable';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
        (OLD.status = 'BUILDING' AND NEW.status = 'SEALED')
        OR (OLD.status = 'SEALED' AND NEW.status = 'CONSENSUS_PENDING')
    ) THEN
        RAISE EXCEPTION 'illegal batch lifecycle transition: % to %', OLD.status, NEW.status;
    END IF;

    IF OLD.status = 'BUILDING' AND NEW.status = 'SEALED' THEN
        EXECUTE format(
            'SELECT COUNT(*) AS member_count, COUNT(m.canonical_position) AS positioned_count,
                    MIN(m.canonical_position) AS first_position, MAX(m.canonical_position) AS last_position,
                    BOOL_AND(s.status = ''FINALIZED'' AND s.source_domain = $2
                        AND s.source_gateway = $3 AND s.message_id = m.message_id) AS valid_members
             FROM %I.message_batch_members m JOIN %I.source_messages s ON s.id = m.source_message_id
             WHERE m.batch_record_id = $1', TG_TABLE_SCHEMA, TG_TABLE_SCHEMA
        ) INTO membership USING NEW.batch_record_id, NEW.source_domain, NEW.source_gateway;
        IF membership.member_count = 0 OR NEW.message_count IS NULL
           OR membership.member_count <> NEW.message_count
           OR membership.positioned_count <> NEW.message_count
           OR membership.first_position <> 0
           OR membership.last_position <> NEW.message_count - 1
           OR membership.valid_members IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'cannot seal empty or inconsistent batch membership';
        END IF;
    END IF;
    RETURN NEW;
END;
$guard$;

CREATE OR REPLACE FUNCTION guard_message_batch_member()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
    target_batch_id BIGINT;
    target_batch RECORD;
    source_message RECORD;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_batch_id := OLD.batch_record_id;
    ELSE
        target_batch_id := NEW.batch_record_id;
    END IF;
    IF TG_OP = 'UPDATE' AND
       ROW(NEW.batch_record_id, NEW.source_message_id, NEW.message_id)
       IS DISTINCT FROM ROW(OLD.batch_record_id, OLD.source_message_id, OLD.message_id) THEN
        RAISE EXCEPTION 'batch member occurrence reference and message ID are immutable';
    END IF;
    EXECUTE format(
        'SELECT source_domain, source_gateway, status FROM %I.message_batches
         WHERE batch_record_id = $1 FOR UPDATE', TG_TABLE_SCHEMA
    ) INTO target_batch USING target_batch_id;
    IF target_batch.status IS NULL THEN
        RAISE EXCEPTION 'batch record does not exist';
    END IF;
    IF target_batch.status <> 'BUILDING' THEN
        RAISE EXCEPTION 'sealed batch membership is immutable';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    IF TG_OP = 'INSERT' AND NEW.canonical_position IS NOT NULL THEN
        RAISE EXCEPTION 'new BUILDING members must have no sealed position';
    END IF;
    EXECUTE format(
        'SELECT source_domain, source_gateway, status, message_id FROM %I.source_messages
         WHERE id = $1 FOR SHARE', TG_TABLE_SCHEMA
    ) INTO source_message USING NEW.source_message_id;
    IF source_message.status IS DISTINCT FROM 'FINALIZED' THEN
        RAISE EXCEPTION 'batch members must reference FINALIZED source occurrences';
    END IF;
    IF source_message.source_domain <> target_batch.source_domain
       OR source_message.source_gateway <> target_batch.source_gateway THEN
        RAISE EXCEPTION 'batch member source scope mismatch';
    END IF;
    IF source_message.message_id <> NEW.message_id THEN
        RAISE EXCEPTION 'batch member canonical message ID mismatch';
    END IF;
    RETURN NEW;
END;
$guard$;

DROP TRIGGER IF EXISTS message_batches_record_guard ON message_batches;
CREATE TRIGGER message_batches_record_guard
    BEFORE INSERT OR UPDATE OR DELETE ON message_batches
    FOR EACH ROW EXECUTE FUNCTION guard_message_batch_record();

DROP TRIGGER IF EXISTS message_batch_members_guard ON message_batch_members;
CREATE TRIGGER message_batch_members_guard
    BEFORE INSERT OR UPDATE OR DELETE ON message_batch_members
    FOR EACH ROW EXECUTE FUNCTION guard_message_batch_member();
