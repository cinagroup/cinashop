-- 订单返佣按 PHP 语义迁移：下单快照，确认收货入账，提现时识别冻结期。
-- 不为历史订单计算或回填佣金，历史数据必须先单独对账。
CREATE TABLE IF NOT EXISTS "agent_level" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "image" VARCHAR(255) DEFAULT '' NOT NULL,
  "color" VARCHAR(32) DEFAULT '' NOT NULL,
  "one_brokerage" SMALLINT DEFAULT 0 NOT NULL,
  "two_brokerage" SMALLINT DEFAULT 0 NOT NULL,
  "grade" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "al_brokerage_ck" CHECK (
    "one_brokerage" BETWEEN 0 AND 1000 AND "two_brokerage" BETWEEN 0 AND 1000
  )
);

CREATE INDEX IF NOT EXISTS "al_status_del" ON "agent_level" ("status", "is_del");

INSERT INTO "agent_level"
  ("id", "name", "image", "color", "one_brokerage", "two_brokerage", "grade", "status", "is_del", "add_time")
VALUES
  (1, '等级一', '/uploads/system/agent_level_1.png', '#D97E1D', 2, 1, 1, 1, 0, 1700126550),
  (2, '等级二', '/uploads/system/agent_level_2.png', '#5D7DAC', 5, 3, 2, 1, 0, 1700126572),
  (3, '等级三', '/uploads/system/agent_level_3.png', '#5856D6', 10, 5, 3, 1, 0, 1700126595),
  (4, '等级四', '/uploads/system/agent_level_4.png', '#1DB0FC', 12, 7, 4, 1, 0, 1700126621),
  (5, '等级五', '/uploads/system/agent_level_5.png', '#AF52DE', 19, 12, 5, 1, 0, 1701764897)
ON CONFLICT ("id") DO NOTHING;

SELECT setval(
  pg_get_serial_sequence('agent_level', 'id'),
  GREATEST((SELECT COALESCE(MAX("id"), 1) FROM "agent_level"), 1),
  true
);

-- 仅补缺失配置；已从 PHP 迁移的商城配置始终优先。
INSERT INTO "system_config" ("menu_name", "value", "info")
SELECT seed.menu_name, seed.value, seed.info
FROM (VALUES
  ('store_brokerage_ratio', '10', '一级返佣比例（%）'),
  ('store_brokerage_two', '5', '二级返佣比例（%）'),
  ('store_brokerage_statu', '1', '分销模式'),
  ('store_brokerage_price', '600', '满额分销最低累计消费金额'),
  ('extract_time', '0', '佣金冻结时间（天）'),
  ('brokerage_func_status', '1', '分销启用'),
  ('is_self_brokerage', '0', '自购返佣'),
  ('brokerage_level', '2', '分销层级'),
  ('brokerage_compute_type', '1', '佣金计算方式')
) AS seed(menu_name, value, info)
WHERE NOT EXISTS (
  SELECT 1 FROM "system_config" existing
  WHERE existing."menu_name" = seed.menu_name AND existing."is_store" = 0
);

ALTER TABLE "store_order" ADD COLUMN IF NOT EXISTS "spread_uid" INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE "store_order" ADD COLUMN IF NOT EXISTS "spread_two_uid" INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE "store_order" ADD COLUMN IF NOT EXISTS "one_brokerage" NUMERIC(12,2) DEFAULT '0.00' NOT NULL;
ALTER TABLE "store_order" ADD COLUMN IF NOT EXISTS "two_brokerage" NUMERIC(12,2) DEFAULT '0.00' NOT NULL;
CREATE INDEX IF NOT EXISTS "so_spread_uid" ON "store_order" ("spread_uid");
CREATE INDEX IF NOT EXISTS "so_spread_two_uid" ON "store_order" ("spread_two_uid");

ALTER TABLE "user_brokerage" ADD COLUMN IF NOT EXISTS "take" SMALLINT DEFAULT 0 NOT NULL;
ALTER TABLE "user_brokerage" ADD COLUMN IF NOT EXISTS "frozen_time" INTEGER DEFAULT 0 NOT NULL;
CREATE INDEX IF NOT EXISTS "ub_frozen_ready"
  ON "user_brokerage" ("frozen_time", "uid")
  WHERE "pm" = 1 AND "status" = 1;
CREATE UNIQUE INDEX IF NOT EXISTS "ub_order_income_uq"
  ON "user_brokerage" ("uid", "link_id", "type")
  WHERE "pm" = 1 AND "type" IN ('self_brokerage', 'one_brokerage', 'two_brokerage');
