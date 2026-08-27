-- Replace the PHP editor's unrestricted plaintext virtual_list replay with a
-- short-lived, actor/tenant-bound and one-time export authorization. Only the
-- SHA-256 digest of the bearer ticket is persisted; card secrets stay in the
-- existing inventory table and the one successful response.
CREATE TABLE IF NOT EXISTS "system_virtual_inventory_export" (
  "id" SERIAL PRIMARY KEY,
  "token_hash" VARCHAR(64) NOT NULL,
  "actor_type" VARCHAR(16) NOT NULL,
  "actor_id" INTEGER NOT NULL,
  "supplier_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER NOT NULL,
  "attr_unique" VARCHAR(20) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "requested_count" INTEGER NOT NULL,
  "exported_count" INTEGER DEFAULT 0 NOT NULL,
  "status" VARCHAR(16) DEFAULT 'READY' NOT NULL,
  "created_at" TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "consumed_at" TIMESTAMPTZ,
  CONSTRAINT "svie_actor_type_ck" CHECK ("actor_type" IN ('admin', 'supplier')),
  CONSTRAINT "svie_status_ck" CHECK ("status" IN ('READY', 'CONSUMED', 'EXPIRED')),
  CONSTRAINT "svie_identity_ck" CHECK (
    "actor_id" > 0 AND "supplier_id" >= 0 AND "product_id" > 0
  ),
  CONSTRAINT "svie_count_ck" CHECK (
    "requested_count" > 0 AND "requested_count" <= 1000
      AND "exported_count" >= 0 AND "exported_count" <= 1000
  ),
  CONSTRAINT "svie_expiry_ck" CHECK ("expires_at" > "created_at")
);

CREATE UNIQUE INDEX IF NOT EXISTS "svie_token_hash_uq"
  ON "system_virtual_inventory_export" ("token_hash");
CREATE INDEX IF NOT EXISTS "svie_actor_history"
  ON "system_virtual_inventory_export" ("actor_type", "actor_id", "id");
CREATE INDEX IF NOT EXISTS "svie_product_history"
  ON "system_virtual_inventory_export" ("product_id", "attr_unique", "id");
CREATE INDEX IF NOT EXISTS "svie_ready_expiry"
  ON "system_virtual_inventory_export" ("expires_at", "id")
  WHERE "status" = 'READY';
