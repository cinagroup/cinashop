-- M1 初始化迁移
-- 对应 PHP eb_user + eb_system_config 两张表
-- 生产用 Drizzle 生成 (npm run db:generate), 这里给手写版本作参考

-- 用户表
CREATE TABLE IF NOT EXISTS "user" (
  "uid" SERIAL PRIMARY KEY,
  "account" VARCHAR(32) DEFAULT '' NOT NULL,
  "pwd" VARCHAR(32) DEFAULT '' NOT NULL,
  "real_name" VARCHAR(25) DEFAULT '' NOT NULL,
  "birthday" INTEGER DEFAULT 0 NOT NULL,
  "card_id" VARCHAR(20) DEFAULT '' NOT NULL,
  "mark" VARCHAR(255) DEFAULT '' NOT NULL,
  "partner_id" INTEGER DEFAULT 0 NOT NULL,
  "group_id" INTEGER DEFAULT 0 NOT NULL,
  "nickname" VARCHAR(60) DEFAULT '' NOT NULL,
  "avatar" VARCHAR(256) DEFAULT '' NOT NULL,
  "phone" VARCHAR(15) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "add_ip" VARCHAR(16) DEFAULT '' NOT NULL,
  "last_time" INTEGER DEFAULT 0 NOT NULL,
  "last_ip" VARCHAR(16) DEFAULT '' NOT NULL,
  "now_money" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "brokerage_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "integral" INTEGER DEFAULT 0 NOT NULL,
  "exp" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "sign_num" INTEGER DEFAULT 0 NOT NULL,
  "sign_remind" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "level" INTEGER DEFAULT 0 NOT NULL,
  "agent_level" INTEGER DEFAULT 0 NOT NULL,
  "spread_open" SMALLINT DEFAULT 1 NOT NULL,
  "spread_uid" INTEGER DEFAULT 0 NOT NULL,
  "spread_time" INTEGER DEFAULT 0 NOT NULL,
  "spread_lottery" INTEGER DEFAULT 1 NOT NULL,
  "work_uid" INTEGER DEFAULT 0 NOT NULL,
  "work_userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "user_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "is_promoter" SMALLINT DEFAULT 0 NOT NULL,
  "pay_count" INTEGER DEFAULT 0 NOT NULL,
  "spread_count" INTEGER DEFAULT 0 NOT NULL,
  "clean_time" INTEGER DEFAULT 0 NOT NULL,
  "addres" VARCHAR(255) DEFAULT '' NOT NULL,
  "adminid" INTEGER DEFAULT 0 NOT NULL,
  "login_type" VARCHAR(36) DEFAULT '' NOT NULL,
  "login_city" VARCHAR(255) DEFAULT '' NOT NULL,
  "record_phone" VARCHAR(11) DEFAULT '' NOT NULL,
  "is_money_level" SMALLINT DEFAULT 0 NOT NULL,
  "is_ever_level" SMALLINT DEFAULT 0 NOT NULL,
  "overdue_time" INTEGER DEFAULT 0 NOT NULL,
  "uniqid" VARCHAR(32) DEFAULT '' NOT NULL,
  "bar_code" VARCHAR(32) DEFAULT '' NOT NULL,
  "rand_code" INTEGER DEFAULT 0 NOT NULL,
  "sex" SMALLINT DEFAULT 0 NOT NULL,
  "provincials" VARCHAR(255) DEFAULT '' NOT NULL,
  "province" INTEGER DEFAULT 0 NOT NULL,
  "city" INTEGER DEFAULT 0 NOT NULL,
  "area" INTEGER DEFAULT 0 NOT NULL,
  "street" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "delete_time" TIMESTAMP,
  "extend_info" TEXT,
  "level_status" SMALLINT DEFAULT 0 NOT NULL,
  "level_extend_info" TEXT,
  "is_first_order" SMALLINT DEFAULT 0 NOT NULL,
  "is_newcomer" SMALLINT DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "user_account_idx" ON "user" ("account");
CREATE INDEX IF NOT EXISTS "user_status_idx" ON "user" ("status");
CREATE INDEX IF NOT EXISTS "user_phone_idx" ON "user" ("phone");
CREATE INDEX IF NOT EXISTS "user_delete_time_idx" ON "user" ("delete_time");

-- 系统配置表
CREATE TABLE IF NOT EXISTS "system_config" (
  "id" SERIAL PRIMARY KEY,
  "is_store" SMALLINT DEFAULT 0 NOT NULL,
  "menu_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "type" VARCHAR(255) DEFAULT '' NOT NULL,
  "input_type" VARCHAR(20) DEFAULT 'input' NOT NULL,
  "config_tab_id" INTEGER DEFAULT 0 NOT NULL,
  "parameter" VARCHAR(255) DEFAULT '' NOT NULL,
  "upload_type" SMALLINT DEFAULT 1 NOT NULL,
  "required" VARCHAR(255) DEFAULT '' NOT NULL,
  "width" INTEGER DEFAULT 0 NOT NULL,
  "high" INTEGER DEFAULT 0 NOT NULL,
  "value" VARCHAR(5000) DEFAULT '' NOT NULL,
  "info" VARCHAR(255) DEFAULT '' NOT NULL,
  "desc" VARCHAR(255) DEFAULT '' NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "system_config_menu_name_idx" ON "system_config" ("menu_name");
CREATE INDEX IF NOT EXISTS "system_config_is_store_idx" ON "system_config" ("is_store");

-- menu_name 只有普通索引；按全局作用域显式判重，避免重复执行时不断追加。
INSERT INTO "system_config" ("menu_name", "value", "info")
SELECT 'record_No', '京ICP备12345678号', '网站备案号'
WHERE NOT EXISTS (
  SELECT 1 FROM "system_config"
  WHERE "menu_name" = 'record_No' AND "is_store" = 0
);
