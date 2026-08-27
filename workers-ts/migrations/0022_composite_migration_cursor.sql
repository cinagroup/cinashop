-- Upgrade existing migration ledgers created before composite keyset support.
ALTER TABLE "data_migration_checkpoint"
  ADD COLUMN IF NOT EXISTS "last_key_json" JSONB;
