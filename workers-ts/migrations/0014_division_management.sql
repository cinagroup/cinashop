-- 事业部管理面：代理商申请工作流、管理员事业部作用域与查询索引。
CREATE TABLE IF NOT EXISTS "division_apply" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "division_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "phone" VARCHAR(32) DEFAULT '0' NOT NULL,
  "division_id" INTEGER DEFAULT 0 NOT NULL,
  "division_invite" INTEGER DEFAULT 0 NOT NULL,
  "images" VARCHAR(2000) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "status_time" INTEGER DEFAULT 0 NOT NULL,
  "refusal_reason" VARCHAR(1000) DEFAULT '' NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "da_division_status"
  ON "division_apply" ("division_id", "status", "is_del");
CREATE INDEX IF NOT EXISTS "da_status_time"
  ON "division_apply" ("status", "add_time");
WITH duplicate_applications AS (
  SELECT "id", row_number() OVER (PARTITION BY "uid" ORDER BY "id" DESC) AS duplicate_rank
  FROM "division_apply"
  WHERE "is_del" = 0
)
UPDATE "division_apply" target
SET "is_del" = 1
FROM duplicate_applications duplicate
WHERE target."id" = duplicate."id" AND duplicate."duplicate_rank" > 1;
CREATE UNIQUE INDEX IF NOT EXISTS "da_uid_active_uq"
  ON "division_apply" ("uid") WHERE "is_del" = 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'da_status_ck' AND conrelid = 'division_apply'::regclass) THEN
    ALTER TABLE "division_apply" ADD CONSTRAINT "da_status_ck"
      CHECK ("status" BETWEEN 0 AND 2) NOT VALID;
  END IF;
END $$;

ALTER TABLE "system_admin" ADD COLUMN IF NOT EXISTS "division_id" INTEGER DEFAULT 0 NOT NULL;
CREATE INDEX IF NOT EXISTS "sa_division" ON "system_admin" ("division_id", "is_del", "status");

-- 邀请码仅约束非零值；历史重复值先保留，待上线前审计后再加唯一约束。
CREATE INDEX IF NOT EXISTS "user_division_invite" ON "user" ("division_invite")
  WHERE "division_invite" <> 0;
