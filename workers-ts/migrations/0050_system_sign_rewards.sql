-- Preserve configurable continuous and cumulative sign-in milestone rewards.
-- The source table has no composite uniqueness constraint, so historical
-- duplicate (type, days) rows must remain importable. Runtime admin writes
-- serialize and reject new duplicates instead.
CREATE TABLE IF NOT EXISTS "system_sign_reward" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "days" INTEGER DEFAULT 0 NOT NULL,
  "point" INTEGER DEFAULT 0 NOT NULL,
  "exp" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_sign_reward_lookup"
  ON "system_sign_reward" ("type", "days", "id");
