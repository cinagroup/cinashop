-- Restore the fulfillment lookup index independently of the original bootstrap.
-- Some upgraded databases already had store_order before the bootstrap migration,
-- and production evidence showed the verify-code index was absent.
CREATE INDEX IF NOT EXISTS "so_verify_code"
  ON "store_order" ("verify_code");
