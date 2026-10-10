-- Active view and timeout intent are distinct. A stalled candidate primary must
-- not prevent a later three-member certificate from activating a higher view.
ALTER TABLE pbft_epoch_views ADD COLUMN IF NOT EXISTS target_view NUMERIC(78,0) NOT NULL DEFAULT 0
    CHECK (target_view >= 0 AND target_view < power(2::numeric,256));
ALTER TABLE pbft_epoch_views ADD COLUMN IF NOT EXISTS view_change_at TIMESTAMPTZ;
ALTER TABLE pbft_epoch_views ADD COLUMN IF NOT EXISTS progress_revision BIGINT NOT NULL DEFAULT 0 CHECK (progress_revision >= 0);

UPDATE pbft_epoch_views s SET target_view = GREATEST(s.current_view,
    COALESCE((SELECT MAX(v.target_view) FROM pbft_view_change_votes v
        WHERE v.local_validator_identity = s.local_validator_identity AND v.epoch = s.epoch
          AND v.voter_identity = s.local_validator_identity),s.current_view)),
    view_change_at = CASE WHEN s.changing_view THEN COALESCE(s.view_change_at,s.progress_at) ELSE s.view_change_at END
WHERE s.target_view < s.current_view OR (s.changing_view AND s.view_change_at IS NULL);

CREATE OR REPLACE FUNCTION guard_pbft_epoch_view()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
    has_evidence BOOLEAN;
BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'consensus history cannot be deleted'; END IF;
    IF ROW(NEW.local_validator_identity,NEW.epoch,NEW.batch_id,NEW.message_root)
        IS DISTINCT FROM ROW(OLD.local_validator_identity,OLD.epoch,OLD.batch_id,OLD.message_root)
        OR NEW.current_view < OLD.current_view OR NEW.target_view < OLD.target_view
        OR NEW.target_view < NEW.current_view OR NEW.progress_revision < OLD.progress_revision
        OR (NEW.changing_view AND (NEW.target_view <= NEW.current_view OR NEW.view_change_at IS NULL))
        OR (OLD.finalized AND (NOT NEW.finalized OR NEW.current_view <> OLD.current_view
            OR NEW.target_view <> OLD.target_view OR NEW.changing_view)) THEN
        RAISE EXCEPTION 'consensus identity, monotonic view/intent, and finality are immutable';
    END IF;
    IF NEW.current_view > OLD.current_view THEN
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.pbft_new_views WHERE local_validator_identity = $1 AND epoch = $2 AND view = $3)', TG_TABLE_SCHEMA)
            INTO has_evidence USING NEW.local_validator_identity,NEW.epoch,NEW.current_view;
        IF NOT has_evidence THEN RAISE EXCEPTION 'advancing view requires persisted NEW_VIEW evidence'; END IF;
    END IF;
    RETURN NEW;
END;
$guard$;
