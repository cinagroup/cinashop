-- Preserve the PHP shipping-region hierarchy and grouping fields. Source
-- temp_id/city_id/group are copied to template_id/region_id/billing_group by
-- the explicit data-migration manifest.
ALTER TABLE "shipping_templates_region"
  ADD COLUMN IF NOT EXISTS "province_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "billing_group" SMALLINT DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "value" VARCHAR(200) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "uniqid" VARCHAR(32) DEFAULT '' NOT NULL;

CREATE INDEX IF NOT EXISTS "str_template_region"
  ON "shipping_templates_region" ("template_id", "region_id");

CREATE INDEX IF NOT EXISTS "str_template_uniqid"
  ON "shipping_templates_region" ("template_id", "uniqid");
