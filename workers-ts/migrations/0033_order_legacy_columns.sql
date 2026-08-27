-- Preserve the complete PHP order snapshot. Several of these columns are
-- redundant with newer normalized refund and fulfillment tables, but they are
-- still required for lossless import and legacy reporting/API compatibility.
ALTER TABLE "store_order"
  ADD COLUMN IF NOT EXISTS "refund_express" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "refund_reason_wap_img" TEXT,
  ADD COLUMN IF NOT EXISTS "refund_reason_wap_explain" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "refund_reason_time" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "refund_reason_wap" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "express_dump" TEXT,
  ADD COLUMN IF NOT EXISTS "kuaidi_label" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "mer_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "cost" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "staff_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "clerk_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "product_type" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "virtual_info" TEXT,
  ADD COLUMN IF NOT EXISTS "custom_form" TEXT,
  ADD COLUMN IF NOT EXISTS "promotions_give" TEXT,
  ADD COLUMN IF NOT EXISTS "give_integral" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "give_coupon" TEXT,
  ADD COLUMN IF NOT EXISTS "erp_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "erp_order_id" VARCHAR(32) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "kuaidi_task_id" VARCHAR(128) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "kuaidi_order_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_stock_up" SMALLINT DEFAULT 0 NOT NULL;

CREATE INDEX IF NOT EXISTS "so_erp_order_id"
  ON "store_order" ("erp_order_id");
