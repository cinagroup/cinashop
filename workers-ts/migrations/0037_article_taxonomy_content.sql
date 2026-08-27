-- Preserve the PHP article taxonomy and one-to-one article body table.
CREATE TABLE IF NOT EXISTS "article_category" (
  "id" SERIAL PRIMARY KEY,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "title" VARCHAR(255) DEFAULT '' NOT NULL,
  "intr" VARCHAR(255) DEFAULT '' NOT NULL,
  "image" VARCHAR(255) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "hidden" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "ac_visible_sort"
  ON "article_category" ("status", "is_del", "hidden", "sort" DESC);

CREATE TABLE IF NOT EXISTS "article_content" (
  "nid" INTEGER PRIMARY KEY,
  "content" TEXT
);
