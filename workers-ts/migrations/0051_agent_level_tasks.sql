-- Preserve distributor upgrade tasks and historical completion evidence.
CREATE TABLE IF NOT EXISTS "agent_level_task" (
  "id" SERIAL PRIMARY KEY,
  "level_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "number" INTEGER DEFAULT 0 NOT NULL,
  "desc" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_must" SMALLINT DEFAULT 0 NOT NULL,
  "sort" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "alt_level_active"
  ON "agent_level_task" ("level_id", "is_del", "status", "sort", "id");
CREATE INDEX IF NOT EXISTS "alt_type_level"
  ON "agent_level_task" ("type", "level_id", "is_del");

-- The source has no uniqueness constraint. Do not collapse duplicate legacy
-- records during import; runtime completion writes serialize on the user row.
CREATE TABLE IF NOT EXISTS "agent_level_task_record" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "level_id" INTEGER DEFAULT 0 NOT NULL,
  "task_id" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 10 NOT NULL
);

CREATE INDEX IF NOT EXISTS "altr_user_level_task"
  ON "agent_level_task_record" ("uid", "level_id", "task_id", "id");
CREATE INDEX IF NOT EXISTS "altr_task_user"
  ON "agent_level_task_record" ("task_id", "uid");
