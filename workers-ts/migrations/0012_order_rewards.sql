-- 确认收货奖励：商品积分、实付返积分、经验与等级历史；退款按累计比例冲正积分。
-- 不为历史已收货订单补发奖励，历史数据必须先单独对账。
ALTER TABLE "user_bill" ADD COLUMN IF NOT EXISTS "event_key" VARCHAR(64) DEFAULT '' NOT NULL;
CREATE INDEX IF NOT EXISTS "ub_event_key" ON "user_bill" ("event_key");
CREATE UNIQUE INDEX IF NOT EXISTS "ub_order_reward_uq"
  ON "user_bill" ("uid", "link_id", "event_key")
  WHERE "event_key" IN ('pay_give_integral', 'order_give_integral', 'order_give_exp');

CREATE TABLE IF NOT EXISTS "member_right" (
  "id" SERIAL PRIMARY KEY,
  "right_type" VARCHAR(100) DEFAULT '' NOT NULL,
  "title" VARCHAR(200) DEFAULT '' NOT NULL,
  "show_title" VARCHAR(255) DEFAULT '' NOT NULL,
  "image" VARCHAR(200) DEFAULT '' NOT NULL,
  "explain" VARCHAR(1024) DEFAULT '' NOT NULL,
  "content" TEXT,
  "number" INTEGER DEFAULT 1 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "mr_number_ck" CHECK ("number" >= 0)
);
CREATE INDEX IF NOT EXISTS "mr_right_type" ON "member_right" ("right_type");
INSERT INTO "member_right"
  ("right_type", "title", "show_title", "image", "explain", "number", "sort", "status", "add_time")
SELECT
  'integral', '消费返利', '消费返利',
  '/uploads/system/1c0fb1ff89e1f6f347fb131544056910.png',
  '消费返多倍积分', 2, 0, 1, 0
WHERE NOT EXISTS (
  SELECT 1 FROM "member_right" existing WHERE existing."right_type" = 'integral'
);

CREATE TABLE IF NOT EXISTS "user_level" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "level_id" INTEGER DEFAULT 0 NOT NULL,
  "grade" INTEGER DEFAULT 0 NOT NULL,
  "valid_time" INTEGER DEFAULT 0 NOT NULL,
  "is_forever" SMALLINT DEFAULT 0 NOT NULL,
  "mer_id" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "mark" VARCHAR(255) DEFAULT '' NOT NULL,
  "remind" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "discount" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "ul_uid_status_del" ON "user_level" ("uid", "status", "is_del");
CREATE INDEX IF NOT EXISTS "ul_uid_level" ON "user_level" ("uid", "level_id");

-- 仅补缺失配置；PHP 迁移过来的实际商城配置始终优先。
INSERT INTO "system_config" ("menu_name", "value", "info")
SELECT seed.menu_name, seed.value, seed.info
FROM (VALUES
  ('order_give_integral', '1', '实际支付 1 元赠送积分数'),
  ('member_func_status', '1', '商城用户等级功能开关'),
  ('order_give_exp', '1', '实际支付 1 元赠送经验数'),
  ('member_card_status', '1', '付费会员功能开关')
) AS seed(menu_name, value, info)
WHERE NOT EXISTS (
  SELECT 1 FROM "system_config" existing
  WHERE existing."menu_name" = seed.menu_name AND existing."is_store" = 0
);
