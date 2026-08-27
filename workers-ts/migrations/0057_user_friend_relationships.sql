-- Preserve the bidirectional friend graph derived from historical distributor
-- bindings. The source has no pair uniqueness constraint, so old duplicates
-- remain importable while new writes serialize in the relationship service.
CREATE TABLE IF NOT EXISTS "user_friends" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "friends_uid" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "uf_uid" ON "user_friends" ("uid");
CREATE INDEX IF NOT EXISTS "uf_friends_uid" ON "user_friends" ("friends_uid");
CREATE INDEX IF NOT EXISTS "uf_pair" ON "user_friends" ("uid", "friends_uid", "id");
