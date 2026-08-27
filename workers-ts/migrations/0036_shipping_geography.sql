-- PHP shipping administration uses system_city, while order calculation expands
-- a selected city_area row's path to match district, city, province, then nationwide.
CREATE TABLE IF NOT EXISTS "system_city" (
  "id" SERIAL PRIMARY KEY,
  "city_id" INTEGER DEFAULT 0 NOT NULL,
  "level" INTEGER DEFAULT 0 NOT NULL,
  "parent_id" INTEGER DEFAULT 0 NOT NULL,
  "area_code" VARCHAR(30) DEFAULT '' NOT NULL,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "merger_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "lng" VARCHAR(50) DEFAULT '' NOT NULL,
  "lat" VARCHAR(50) DEFAULT '' NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sc_city_id" ON "system_city" ("city_id");
CREATE INDEX IF NOT EXISTS "sc_parent_show" ON "system_city" ("parent_id", "is_show");

CREATE TABLE IF NOT EXISTS "city_area" (
  "id" SERIAL PRIMARY KEY,
  "path" VARCHAR(128) DEFAULT '/' NOT NULL,
  "parent_id" INTEGER DEFAULT 0 NOT NULL,
  "type" VARCHAR(32) DEFAULT '' NOT NULL,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "level" SMALLINT DEFAULT 0 NOT NULL,
  "code" VARCHAR(100) DEFAULT '' NOT NULL,
  "snum" INTEGER DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "ca_parent" ON "city_area" ("parent_id");
CREATE INDEX IF NOT EXISTS "ca_path" ON "city_area" ("path");
