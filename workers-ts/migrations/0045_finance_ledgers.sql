-- Keep platform external cash movements distinct from user balance and supplier ledgers.
CREATE TABLE IF NOT EXISTS "capital_flow" (
  "id" SERIAL PRIMARY KEY,
  "flow_id" VARCHAR(32) DEFAULT '' NOT NULL,
  "order_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "nickname" VARCHAR(255) DEFAULT '' NOT NULL,
  "phone" VARCHAR(20) DEFAULT '' NOT NULL,
  "price" NUMERIC(12, 2) DEFAULT 0.00 NOT NULL,
  "trading_type" SMALLINT DEFAULT 0 NOT NULL,
  "pay_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "mark" VARCHAR(500) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "cf_flow_id" ON "capital_flow" ("flow_id");
CREATE INDEX IF NOT EXISTS "cf_order_id" ON "capital_flow" ("order_id");
CREATE INDEX IF NOT EXISTS "cf_uid_type_time"
  ON "capital_flow" ("uid", "trading_type", "add_time", "id");
CREATE INDEX IF NOT EXISTS "cf_type_time"
  ON "capital_flow" ("trading_type", "add_time", "id");
CREATE INDEX IF NOT EXISTS "cf_store_time"
  ON "capital_flow" ("store_id", "add_time", "id");

-- Dormant legacy store ledger: preserve independently; do not merge into active platform cash flow.
CREATE TABLE IF NOT EXISTS "store_finance_flow" (
  "id" SERIAL PRIMARY KEY,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "staff_id" INTEGER DEFAULT 0 NOT NULL,
  "order_id" VARCHAR(20) DEFAULT '' NOT NULL,
  "link_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "pm" SMALLINT DEFAULT 0 NOT NULL,
  "number" NUMERIC(12, 2) DEFAULT 0.00 NOT NULL,
  "type" VARCHAR(50) DEFAULT '' NOT NULL,
  "pay_type" VARCHAR(20) DEFAULT '' NOT NULL,
  "pay_price" NUMERIC(12, 2) DEFAULT 0.00 NOT NULL,
  "total_price" NUMERIC(12, 2) DEFAULT 0.00 NOT NULL,
  "rate" SMALLINT DEFAULT 0 NOT NULL,
  "trade_type" SMALLINT DEFAULT 1 NOT NULL,
  "remark" VARCHAR(512) DEFAULT '' NOT NULL,
  "mark" VARCHAR(255) DEFAULT '' NOT NULL,
  "trade_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sff_store_type_time"
  ON "store_finance_flow" ("store_id", "type", "add_time", "id");
CREATE INDEX IF NOT EXISTS "sff_uid_time"
  ON "store_finance_flow" ("uid", "add_time", "id");
CREATE INDEX IF NOT EXISTS "sff_staff_time"
  ON "store_finance_flow" ("staff_id", "add_time", "id");
CREATE INDEX IF NOT EXISTS "sff_order_id" ON "store_finance_flow" ("order_id");
CREATE INDEX IF NOT EXISTS "sff_link_id" ON "store_finance_flow" ("link_id");
