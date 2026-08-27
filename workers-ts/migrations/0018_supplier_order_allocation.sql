-- 支付后按 Supplier 自动分配订单：显式记录待分配状态，避免混合订单在子单生成前被错误履约。
ALTER TABLE "store_order"
  ADD COLUMN IF NOT EXISTS "supplier_allocation_status" SMALLINT DEFAULT 0 NOT NULL;

-- 已存在的审计主单已经完成过拆分；历史普通/单 Supplier 订单保持 0，由后续处理按需确认。
UPDATE "store_order"
SET "supplier_allocation_status" = 2
WHERE "pid" = -1
  AND "supplier_allocation_status" = 0;

CREATE INDEX IF NOT EXISTS "so_supplier_allocation_pending"
  ON "store_order" ("paid", "supplier_allocation_status", "id")
  WHERE "supplier_allocation_status" = 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'so_supplier_allocation_status_ck'
      AND conrelid = 'store_order'::regclass
  ) THEN
    ALTER TABLE "store_order"
      ADD CONSTRAINT "so_supplier_allocation_status_ck"
      CHECK ("supplier_allocation_status" BETWEEN 0 AND 2) NOT VALID;
  END IF;
END $$;
