-- Preserve user search history/result caches and page visit analytics.
-- Historical duplicate search rows remain importable; new per-user keyword
-- updates are serialized by the Worker service instead of inventing a source
-- uniqueness constraint.
CREATE TABLE IF NOT EXISTS "user_search" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "keyword" VARCHAR(255) DEFAULT '' NOT NULL,
  "vicword" VARCHAR(1000) DEFAULT '' NOT NULL,
  "num" INTEGER DEFAULT 1 NOT NULL,
  "result" TEXT,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "user_search_uid_active_time"
  ON "user_search" ("uid", "is_del", "add_time" DESC, "num" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "user_search_uid_keyword_active"
  ON "user_search" ("uid", "keyword", "is_del", "add_time" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "user_search_keyword_cache"
  ON "user_search" ("keyword", "add_time" DESC, "id" DESC);

CREATE TABLE IF NOT EXISTS "user_visit" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "url" VARCHAR(255) DEFAULT '' NOT NULL,
  "ip" VARCHAR(255) DEFAULT '' NOT NULL,
  "stay_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "channel_type" VARCHAR(255) DEFAULT '' NOT NULL,
  "province" VARCHAR(255) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "user_visit_channel_time"
  ON "user_visit" ("channel_type", "add_time", "id");
CREATE INDEX IF NOT EXISTS "user_visit_uid_time"
  ON "user_visit" ("uid", "add_time", "id");
CREATE INDEX IF NOT EXISTS "user_visit_province_time"
  ON "user_visit" ("province", "add_time", "id");
