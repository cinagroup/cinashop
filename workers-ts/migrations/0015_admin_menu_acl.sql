-- 后台菜单级 ACL：保留 PHP system_menus 结构，并由 Worker 权限目录执行服务端鉴权。
CREATE TABLE IF NOT EXISTS "system_menus" (
  "id" SERIAL PRIMARY KEY,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "icon" VARCHAR(50) DEFAULT '' NOT NULL,
  "menu_name" VARCHAR(64) DEFAULT '' NOT NULL,
  "module" VARCHAR(32) DEFAULT '' NOT NULL,
  "controller" VARCHAR(64) DEFAULT '' NOT NULL,
  "action" VARCHAR(32) DEFAULT '' NOT NULL,
  "api_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "methods" VARCHAR(32) DEFAULT '' NOT NULL,
  "params" VARCHAR(512) DEFAULT '[]' NOT NULL,
  "sort" INTEGER DEFAULT 1 NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "is_show_path" SMALLINT DEFAULT 0 NOT NULL,
  "access" SMALLINT DEFAULT 1 NOT NULL,
  "menu_path" VARCHAR(255) DEFAULT '' NOT NULL,
  "path" VARCHAR(255) DEFAULT '' NOT NULL,
  "auth_type" SMALLINT DEFAULT 0 NOT NULL,
  "header" VARCHAR(50) DEFAULT '' NOT NULL,
  "is_header" SMALLINT DEFAULT 0 NOT NULL,
  "unique_auth" VARCHAR(150) DEFAULT '' NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sm_parent_sort"
  ON "system_menus" ("type", "pid", "sort");
CREATE INDEX IF NOT EXISTS "sm_unique_auth"
  ON "system_menus" ("unique_auth", "is_del");
CREATE INDEX IF NOT EXISTS "sm_api_method"
  ON "system_menus" ("type", "auth_type", "methods", "api_url", "is_del");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sm_type_ck' AND conrelid = 'system_menus'::regclass) THEN
    ALTER TABLE "system_menus" ADD CONSTRAINT "sm_type_ck"
      CHECK ("type" BETWEEN 1 AND 4) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sm_auth_type_ck' AND conrelid = 'system_menus'::regclass) THEN
    ALTER TABLE "system_menus" ADD CONSTRAINT "sm_auth_type_ck"
      CHECK ("auth_type" BETWEEN 0 AND 2) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sm_flags_ck' AND conrelid = 'system_menus'::regclass) THEN
    ALTER TABLE "system_menus" ADD CONSTRAINT "sm_flags_ck"
      CHECK (
        "is_show" BETWEEN 0 AND 1 AND
        "is_show_path" BETWEEN 0 AND 1 AND
        "access" BETWEEN 0 AND 1 AND
        "is_header" BETWEEN 0 AND 1 AND
        "is_del" BETWEEN 0 AND 1
      ) NOT VALID;
  END IF;
END $$;
