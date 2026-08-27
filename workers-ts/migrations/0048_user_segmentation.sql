-- Preserve user groups and the many-to-many user label assignments.
CREATE TABLE IF NOT EXISTS "user_group" (
  "id" SERIAL PRIMARY KEY,
  "group_name" VARCHAR(64) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "user_group_name" ON "user_group" ("group_name");

-- The source has no uniqueness constraint. Do not collapse historical duplicate
-- assignments during migration; runtime writes serialize on the user row.
CREATE TABLE IF NOT EXISTS "user_label_relation" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "label_id" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "ulr_scope_user"
  ON "user_label_relation" ("type", "relation_id", "uid", "id");
CREATE INDEX IF NOT EXISTS "ulr_scope_label_user"
  ON "user_label_relation" ("type", "relation_id", "label_id", "uid");
