-- Supplier 独立后台核心表
-- 对应 legacy eb_system_supplier；登录账号位于 system_admin(admin_type=4)。

CREATE TABLE IF NOT EXISTS "system_supplier" (
  "id" SERIAL PRIMARY KEY,
  "admin_id" INTEGER DEFAULT 0 NOT NULL,
  "supplier_name" VARCHAR(50) DEFAULT '' NOT NULL,
  "avatar" VARCHAR(255) DEFAULT '' NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "phone" VARCHAR(15) DEFAULT '' NOT NULL,
  "email" VARCHAR(50) DEFAULT '' NOT NULL,
  "address" VARCHAR(255) DEFAULT '' NOT NULL,
  "province" INTEGER DEFAULT 0 NOT NULL,
  "city" INTEGER DEFAULT 0 NOT NULL,
  "area" INTEGER DEFAULT 0 NOT NULL,
  "street" INTEGER DEFAULT 0 NOT NULL,
  "detailed_address" VARCHAR(255) DEFAULT '' NOT NULL,
  "bank_code" VARCHAR(32) DEFAULT '0' NOT NULL,
  "bank_address" VARCHAR(256) DEFAULT '' NOT NULL,
  "alipay_account" VARCHAR(64) DEFAULT '' NOT NULL,
  "alipay_qrcode_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "wechat" VARCHAR(15) DEFAULT '' NOT NULL,
  "wechat_qrcode_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "mark" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "business" INTEGER DEFAULT 0 NOT NULL,
  "city_shop_id" VARCHAR(255) DEFAULT '' NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "supplier_admin_id_uq" ON "system_supplier" ("admin_id");
CREATE INDEX IF NOT EXISTS "supplier_status_idx" ON "system_supplier" ("is_show", "is_del");
