-- 第三方原路退款状态机：渠道受理与本地退款完成分离，商户退款号稳定且唯一。

CREATE TABLE IF NOT EXISTS "store_order_refund_payment" (
  "id" SERIAL PRIMARY KEY,
  "refund_id" INTEGER NOT NULL,
  "store_order_id" INTEGER NOT NULL,
  "provider" VARCHAR(16) NOT NULL,
  "out_refund_no" VARCHAR(64) NOT NULL,
  "provider_refund_id" VARCHAR(100) DEFAULT '' NOT NULL,
  "provider_status" VARCHAR(24) DEFAULT 'CREATED' NOT NULL,
  "request_amount" INTEGER DEFAULT 0 NOT NULL,
  "total_amount" INTEGER DEFAULT 0 NOT NULL,
  "attempt_count" INTEGER DEFAULT 0 NOT NULL,
  "request_time" INTEGER DEFAULT 0 NOT NULL,
  "query_time" INTEGER DEFAULT 0 NOT NULL,
  "notify_time" INTEGER DEFAULT 0 NOT NULL,
  "success_time" INTEGER DEFAULT 0 NOT NULL,
  "last_error" VARCHAR(512) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "sorp_provider_ck" CHECK ("provider" IN ('wechat', 'alipay')),
  CONSTRAINT "sorp_status_ck" CHECK (
    "provider_status" IN ('CREATED', 'REQUESTING', 'PROCESSING', 'SUCCESS', 'CLOSED', 'ABNORMAL', 'FAILED', 'UNKNOWN')
  ),
  CONSTRAINT "sorp_amount_ck" CHECK (
    "request_amount" >= 0 AND "total_amount" >= 0 AND "request_amount" <= "total_amount"
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "sorp_refund_id_uq"
  ON "store_order_refund_payment" ("refund_id");
CREATE UNIQUE INDEX IF NOT EXISTS "sorp_out_refund_no_uq"
  ON "store_order_refund_payment" ("out_refund_no");
CREATE INDEX IF NOT EXISTS "sorp_order_id"
  ON "store_order_refund_payment" ("store_order_id");
CREATE INDEX IF NOT EXISTS "sorp_provider_status"
  ON "store_order_refund_payment" ("provider", "provider_status");
