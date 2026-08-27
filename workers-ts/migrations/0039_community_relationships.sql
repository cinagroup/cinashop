-- Preserve legacy community topics, polymorphic relations, and author counters.
CREATE TABLE IF NOT EXISTS "community_topic" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "icon" VARCHAR(128) DEFAULT '' NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "is_recommend" SMALLINT DEFAULT 0 NOT NULL,
  "use_num" INTEGER DEFAULT 0 NOT NULL,
  "view_num" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "ct_visible_sort"
  ON "community_topic" ("status", "is_del", "sort", "id");
CREATE INDEX IF NOT EXISTS "ct_recommend_sort"
  ON "community_topic" ("status", "is_del", "is_recommend", "sort");

CREATE TABLE IF NOT EXISTS "community_relevance" (
  "id" SERIAL PRIMARY KEY,
  "left_id" INTEGER DEFAULT 0 NOT NULL,
  "right_id" INTEGER DEFAULT 0 NOT NULL,
  "type" VARCHAR(32) NOT NULL
);

CREATE INDEX IF NOT EXISTS "cr_left_type_right"
  ON "community_relevance" ("left_id", "type", "right_id");
CREATE INDEX IF NOT EXISTS "cr_right_type_left"
  ON "community_relevance" ("right_id", "type", "left_id");

CREATE TABLE IF NOT EXISTS "community_user" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 2 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "nickname" VARCHAR(255) DEFAULT '' NOT NULL,
  "avatar" VARCHAR(255) DEFAULT '' NOT NULL,
  "desc" VARCHAR(255) DEFAULT '' NOT NULL,
  "community_num" INTEGER DEFAULT 0 NOT NULL,
  "follow_num" INTEGER DEFAULT 0 NOT NULL,
  "fans_num" INTEGER DEFAULT 0 NOT NULL,
  "friend_num" INTEGER DEFAULT 0 NOT NULL,
  "like_num" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "cu_relation_type"
  ON "community_user" ("relation_id", "type", "is_del");
CREATE INDEX IF NOT EXISTS "cu_public_activity"
  ON "community_user" ("status", "is_del", "community_num", "id");
