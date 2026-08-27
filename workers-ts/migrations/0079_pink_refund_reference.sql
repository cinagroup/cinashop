-- PHP stores a store_pink row id in is_refund when a leader or member exits.
-- SMALLINT rejects normal production ids above 32767, so widen the reference
-- without changing existing values or the active sentinel (0).
ALTER TABLE "store_pink"
  ALTER COLUMN "is_refund" TYPE INTEGER
  USING "is_refund"::INTEGER;
