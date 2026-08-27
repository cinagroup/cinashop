-- Preserve source database-backed JSON documents. Expired rows remain
-- importable as historical data; Worker reads ignore them without deleting
-- rows during a storefront request.
CREATE TABLE IF NOT EXISTS "cache" (
  "key" VARCHAR(32) PRIMARY KEY,
  "result" TEXT,
  "expire_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "cache_expire_time"
  ON "cache" ("expire_time", "key");
