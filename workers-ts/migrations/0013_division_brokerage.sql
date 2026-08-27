-- 事业部/代理商/员工差额分佣：下单快照，确认收货入账，退款累计冲正。
-- 不回填历史订单佣金；执行前必须检查历史 user_brokerage 是否存在重复角色流水。
ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS "division_name" VARCHAR(32) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_type" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_status" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "agent_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "staff_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_percent" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_end_time" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_change_time" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_invite" INTEGER DEFAULT 0 NOT NULL;
CREATE INDEX IF NOT EXISTS "user_division_parent" ON "user" ("division_id", "agent_id", "staff_id");
CREATE INDEX IF NOT EXISTS "user_division_role" ON "user" ("division_type", "division_status", "division_end_time");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_division_type_ck' AND conrelid = '"user"'::regclass) THEN
    ALTER TABLE "user" ADD CONSTRAINT "user_division_type_ck" CHECK ("division_type" BETWEEN 0 AND 3) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_division_status_ck' AND conrelid = '"user"'::regclass) THEN
    ALTER TABLE "user" ADD CONSTRAINT "user_division_status_ck" CHECK ("division_status" BETWEEN 0 AND 1) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_division_percent_ck' AND conrelid = '"user"'::regclass) THEN
    ALTER TABLE "user" ADD CONSTRAINT "user_division_percent_ck" CHECK ("division_percent" BETWEEN 0 AND 100) NOT VALID;
  END IF;
END $$;

ALTER TABLE "store_order"
  ADD COLUMN IF NOT EXISTS "division_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_brokerage" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_agent_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_agent_brokerage" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_staff_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_staff_brokerage" NUMERIC(12,2) DEFAULT '0.00' NOT NULL;
CREATE INDEX IF NOT EXISTS "so_division_id" ON "store_order" ("division_id");
CREATE INDEX IF NOT EXISTS "so_division_agent_id" ON "store_order" ("division_agent_id");
CREATE INDEX IF NOT EXISTS "so_division_staff_id" ON "store_order" ("division_staff_id");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'so_division_brokerage_ck' AND conrelid = 'store_order'::regclass) THEN
    ALTER TABLE "store_order" ADD CONSTRAINT "so_division_brokerage_ck"
      CHECK ("division_brokerage" >= 0 AND "division_agent_brokerage" >= 0 AND "division_staff_brokerage" >= 0) NOT VALID;
  END IF;
END $$;

ALTER TABLE "user_brokerage" ADD COLUMN IF NOT EXISTS "source_type" VARCHAR(64) DEFAULT '' NOT NULL;
CREATE INDEX IF NOT EXISTS "ub_refund_source"
  ON "user_brokerage" ("link_id", "pm", "type", "source_type");
CREATE UNIQUE INDEX IF NOT EXISTS "ub_order_division_income_uq"
  ON "user_brokerage" ("uid", "link_id", "type")
  WHERE "pm" = 1 AND "type" IN ('staff_brokerage', 'agent_brokerage', 'division_brokerage');

INSERT INTO "system_config" ("menu_name", "value", "info")
SELECT 'division_status', '1', '事业部/代理商分佣开关'
WHERE NOT EXISTS (
  SELECT 1 FROM "system_config" existing
  WHERE existing."menu_name" = 'division_status' AND existing."is_store" = 0
);
