-- Payment callbacks look up recharge orders by provider order number and the
-- cashier lists a user's current payment state. Preserve duplicate legacy rows
-- for audit; application code refuses ambiguous callbacks instead of choosing
-- one silently.
CREATE INDEX IF NOT EXISTS "ur_order_id_lookup"
  ON "user_recharge" ("order_id");
CREATE INDEX IF NOT EXISTS "ur_uid"
  ON "user_recharge" ("uid");
CREATE INDEX IF NOT EXISTS "ur_uid_paid_time"
  ON "user_recharge" ("uid", "paid", "add_time", "id");
