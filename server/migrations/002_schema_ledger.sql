-- 002_schema_ledger.sql — FROZEN once applied. Do not edit.
--
-- The first migration after the baseline. It deliberately changes nothing: its
-- job is to exercise the ordered path with a real second entry rather than
-- leaving it theoretical until the first schema change needs it, and to prove
-- that adding a migration does not alter 001's checksum.
--
-- Future schema changes are 003_*.sql and onward. Nothing is ever added here or
-- to 001 — a migration's content is frozen the moment any database records it.
SELECT 1;
