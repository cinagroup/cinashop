-- Preserve PHP designated-free-shipping and no-delivery region rules.
CREATE TABLE IF NOT EXISTS "shipping_templates_free" (
  "id" SERIAL PRIMARY KEY,
  "province_id" INTEGER DEFAULT 0 NOT NULL,
  "temp_id" INTEGER DEFAULT 0 NOT NULL,
  "city_id" INTEGER DEFAULT 0 NOT NULL,
  "number" NUMERIC(10, 2) DEFAULT '0.00' NOT NULL,
  "price" NUMERIC(10, 2) DEFAULT '0.00' NOT NULL,
  "group" SMALLINT DEFAULT 1 NOT NULL,
  "value" VARCHAR(200) DEFAULT '' NOT NULL,
  "uniqid" VARCHAR(32) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "stf_temp_city"
  ON "shipping_templates_free" ("temp_id", "city_id");
CREATE INDEX IF NOT EXISTS "stf_temp_uniqid"
  ON "shipping_templates_free" ("temp_id", "uniqid");

CREATE TABLE IF NOT EXISTS "shipping_templates_no_delivery" (
  "id" SERIAL PRIMARY KEY,
  "province_id" INTEGER DEFAULT 0 NOT NULL,
  "temp_id" INTEGER DEFAULT 0 NOT NULL,
  "city_id" INTEGER DEFAULT 0 NOT NULL,
  "value" VARCHAR(200) DEFAULT '' NOT NULL,
  "uniqid" VARCHAR(32) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "stnd_temp_city"
  ON "shipping_templates_no_delivery" ("temp_id", "city_id");
CREATE INDEX IF NOT EXISTS "stnd_temp_uniqid"
  ON "shipping_templates_no_delivery" ("temp_id", "uniqid");
