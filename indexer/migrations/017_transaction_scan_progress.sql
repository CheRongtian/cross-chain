-- Independent account-scoped observation progress, separate from nonce allocation.
ALTER TABLE transaction_accounts
    ADD COLUMN receipt_scan_cursor_nonce NUMERIC(78,0)
        CHECK (receipt_scan_cursor_nonce >= 0 AND receipt_scan_cursor_nonce < power(2::numeric,256)),
    ADD COLUMN recovery_scan_cursor_nonce NUMERIC(78,0)
        CHECK (recovery_scan_cursor_nonce >= 0 AND recovery_scan_cursor_nonce < power(2::numeric,256));
