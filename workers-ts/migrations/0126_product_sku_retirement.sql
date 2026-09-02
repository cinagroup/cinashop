-- Recoverable product SKU retirement.
ALTER TABLE "store_product_attr_value"
  ADD COLUMN IF NOT EXISTS "is_retired" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "retired_at" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "retired_by" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "retire_reason" VARCHAR(255) DEFAULT '' NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'spav_is_retired_ck'
      AND conrelid = 'store_product_attr_value'::regclass
  ) THEN
    ALTER TABLE "store_product_attr_value"
      ADD CONSTRAINT "spav_is_retired_ck" CHECK ("is_retired" IN (0, 1)) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "spav_product_active"
  ON "store_product_attr_value" ("product_id", "type", "is_retired", "id");

CREATE TABLE IF NOT EXISTS "store_product_sku_retirement_log" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER NOT NULL,
  "sku_id" INTEGER NOT NULL,
  "unique_snapshot" CHAR(8) DEFAULT '' NOT NULL,
  "suk_snapshot" VARCHAR(512) DEFAULT '' NOT NULL,
  "action" VARCHAR(16) NOT NULL,
  "reason" VARCHAR(255) DEFAULT '' NOT NULL,
  "actor_id" INTEGER DEFAULT 0 NOT NULL,
  "actor_name" VARCHAR(64) DEFAULT '' NOT NULL,
  "actor_ip" VARCHAR(45) DEFAULT '' NOT NULL,
  "dependency_snapshot" TEXT DEFAULT '{}' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "spsrl_product_time"
  ON "store_product_sku_retirement_log" ("product_id", "add_time", "id");
CREATE INDEX IF NOT EXISTS "spsrl_sku_time"
  ON "store_product_sku_retirement_log" ("sku_id", "add_time", "id");

CREATE OR REPLACE FUNCTION "guard_retired_product_sku"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."is_retired" = 1 THEN
      RAISE EXCEPTION 'retired product SKU cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."is_retired" = 1 OR NEW."is_retired" = 1 THEN
    IF NEW."product_id" <> OLD."product_id"
      OR NEW."type" <> OLD."type"
      OR NEW."suk" <> OLD."suk"
      OR NEW."unique" <> OLD."unique" THEN
      RAISE EXCEPTION 'retired product SKU identity is immutable';
    END IF;
    IF NEW."stock" < OLD."stock" THEN
      RAISE EXCEPTION 'retired product SKU stock cannot be consumed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "store_product_attr_value_retired_guard"
  ON "store_product_attr_value";
CREATE TRIGGER "store_product_attr_value_retired_guard"
BEFORE UPDATE OR DELETE ON "store_product_attr_value"
FOR EACH ROW EXECUTE FUNCTION "guard_retired_product_sku"();
