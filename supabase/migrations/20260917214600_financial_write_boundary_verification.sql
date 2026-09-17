-- Verification-only migration marker. No data mutation.
-- The preceding migration revokes direct client writes from financial tables.
SELECT 1;
