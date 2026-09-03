-- Bounded reference checks before an Admin disables or deletes a system form.
CREATE INDEX IF NOT EXISTS "store_product_system_form_active"
  ON "store_product" ("system_form_id", "is_del")
  WHERE "system_form_id" > 0;

CREATE INDEX IF NOT EXISTS "store_seckill_system_form_active"
  ON "store_seckill" ("system_form_id", "is_del", "status")
  WHERE "system_form_id" > 0;

CREATE INDEX IF NOT EXISTS "store_combination_system_form_active"
  ON "store_combination" ("system_form_id", "is_del", "status")
  WHERE "system_form_id" > 0;

CREATE INDEX IF NOT EXISTS "store_bargain_system_form_active"
  ON "store_bargain" ("system_form_id", "is_del", "status")
  WHERE "system_form_id" > 0;

CREATE INDEX IF NOT EXISTS "store_integral_system_form_active"
  ON "store_integral" ("system_form_id", "is_del", "status")
  WHERE "system_form_id" > 0;
