-- M4 退款 + 订单状态日志迁移
-- 对应 eb_store_order_refund + eb_store_order_status

-- 退款记录
CREATE TABLE IF NOT EXISTS "store_order_refund" (
  "id" SERIAL PRIMARY KEY,
  "store_order_id" INTEGER DEFAULT 0 NOT NULL,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "order_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "supplier_id" INTEGER DEFAULT 0 NOT NULL,
  "apply_type" SMALLINT DEFAULT 0 NOT NULL,
  "apply_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "refund_type" SMALLINT DEFAULT 0 NOT NULL,
  "refund_num" INTEGER DEFAULT 0 NOT NULL,
  "refund_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "refunded_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "refund_reason" VARCHAR(255) DEFAULT '' NOT NULL,
  "refund_phone" VARCHAR(32) DEFAULT '' NOT NULL,
  "refund_express" VARCHAR(100) DEFAULT '' NOT NULL,
  "refund_express_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "refund_explain" VARCHAR(255) DEFAULT '' NOT NULL,
  "refund_img" TEXT,
  "refund_goods_explain" VARCHAR(255) DEFAULT '' NOT NULL,
  "refund_goods_img" TEXT,
  "refuse_reason" VARCHAR(255) DEFAULT '' NOT NULL,
  "remark" VARCHAR(255) DEFAULT '' NOT NULL,
  "refunded_time" INTEGER DEFAULT 0 NOT NULL,
  "cart_info" TEXT,
  "is_cancel" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "sor_store_order_id_idx" ON "store_order_refund" ("store_order_id");
CREATE INDEX IF NOT EXISTS "sor_uid_idx" ON "store_order_refund" ("uid");
CREATE INDEX IF NOT EXISTS "sor_cancel_oid_idx" ON "store_order_refund" ("is_cancel", "store_order_id");

-- 订单状态日志
CREATE TABLE IF NOT EXISTS "store_order_status" (
  "id" SERIAL PRIMARY KEY,
  "oid" INTEGER DEFAULT 0 NOT NULL,
  "change_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "change_message" VARCHAR(256) DEFAULT '' NOT NULL,
  "change_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "sos_oid_idx" ON "store_order_status" ("oid");
CREATE INDEX IF NOT EXISTS "sos_change_time_idx" ON "store_order_status" ("change_time");
