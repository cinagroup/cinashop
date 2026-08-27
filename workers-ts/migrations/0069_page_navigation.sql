-- Source-shaped page-link catalogue used by the legacy DIY editor.
-- No foreign keys or uniqueness constraints are added because the PHP schema
-- permits historical orphans and duplicate links.
CREATE TABLE IF NOT EXISTS "page_category" (
  "id" SERIAL PRIMARY KEY,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "type" VARCHAR(50) DEFAULT 'link' NOT NULL,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "sort" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "page_category_tree_lookup"
  ON "page_category" ("pid", "sort" DESC, "id" ASC);

CREATE TABLE IF NOT EXISTS "page_link" (
  "id" SERIAL PRIMARY KEY,
  "cate_id" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "url" VARCHAR(255) DEFAULT '' NOT NULL,
  "param" VARCHAR(255) DEFAULT '' NOT NULL,
  "example" VARCHAR(255) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "sort" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "page_link_category_lookup"
  ON "page_link" ("cate_id", "sort" DESC, "id" ASC);
