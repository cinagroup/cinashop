-- 供应商拆单/分包发货：补齐 PHP store_order_cart_info 拆分状态，并为待发货子单查询建索引。
ALTER TABLE "store_order_cart_info"
  ADD COLUMN IF NOT EXISTS "old_cart_id" VARCHAR(50) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "split_surplus_num" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "split_status" SMALLINT DEFAULT 0 NOT NULL;

-- 旧 TS 订单未维护 split_surplus_num；仅初始化从未拆分的行，退款数量不再进入可发货数量。
UPDATE "store_order_cart_info"
SET "split_surplus_num" = greatest("cart_num" - "refund_num", 0),
    "surplus_num" = greatest("cart_num" - "refund_num", 0)
WHERE "split_status" = 0
  AND "split_surplus_num" = 0
  AND "cart_num" > 0;

CREATE INDEX IF NOT EXISTS "soci_split_pending"
  ON "store_order_cart_info" ("oid", "split_status", "id");
CREATE INDEX IF NOT EXISTS "soci_old_cart_id"
  ON "store_order_cart_info" ("old_cart_id")
  WHERE "old_cart_id" <> '';
CREATE INDEX IF NOT EXISTS "so_split_pending"
  ON "store_order" ("pid", "supplier_id", "status", "is_system_del", "id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'soci_split_state_ck'
      AND conrelid = 'store_order_cart_info'::regclass
  ) THEN
    ALTER TABLE "store_order_cart_info"
      ADD CONSTRAINT "soci_split_state_ck"
      CHECK ("split_status" BETWEEN 0 AND 2 AND "split_surplus_num" >= 0) NOT VALID;
  END IF;
END $$;
