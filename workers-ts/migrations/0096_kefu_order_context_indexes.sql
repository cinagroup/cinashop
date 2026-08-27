-- Assigned customer order/refund context. Partial predicates match the Kefu read contracts.
CREATE INDEX IF NOT EXISTS "so_kefu_customer_orders"
  ON "store_order" ("uid", "id" DESC)
  WHERE "is_system_del" = 0
    AND "is_del" = 0
    AND "store_id" = 0
    AND "pid" = 0
    AND "refund_type" IN (0, 1, 3, 6);

CREATE INDEX IF NOT EXISTS "sor_kefu_customer_refunds"
  ON "store_order_refund" ("uid", "add_time" DESC, "id" DESC)
  WHERE "is_cancel" = 0 AND "is_del" = 0;
