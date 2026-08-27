-- Preserve third-party same-city delivery state, locations, fees, and completion codes.
CREATE TABLE IF NOT EXISTS "store_delivery_order" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "oid" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "station_type" INTEGER DEFAULT 0 NOT NULL,
  "order_id" VARCHAR(32) DEFAULT '' NOT NULL,
  "delivery_no" VARCHAR(255) DEFAULT '' NOT NULL,
  "city_code" VARCHAR(20) DEFAULT '' NOT NULL,
  "cargo_price" NUMERIC(8, 2) DEFAULT 0.00 NOT NULL,
  "finish_code" VARCHAR(255) DEFAULT '' NOT NULL,
  "user_name" VARCHAR(20) DEFAULT '' NOT NULL,
  "receiver_phone" VARCHAR(11) DEFAULT '' NOT NULL,
  "from_address" VARCHAR(255) DEFAULT '' NOT NULL,
  "to_address" VARCHAR(255) DEFAULT '' NOT NULL,
  "from_lat" VARCHAR(255) DEFAULT '' NOT NULL,
  "from_lng" VARCHAR(255) DEFAULT '' NOT NULL,
  "to_lat" VARCHAR(255) DEFAULT '' NOT NULL,
  "to_lng" VARCHAR(255) DEFAULT '' NOT NULL,
  "distance" REAL DEFAULT 0 NOT NULL,
  "fee" NUMERIC(8, 2) DEFAULT 0.00 NOT NULL,
  "deduct_fee" NUMERIC(8, 2) DEFAULT 0.00 NOT NULL,
  "mer_id" INTEGER DEFAULT 0 NOT NULL,
  "mark" VARCHAR(255) DEFAULT '' NOT NULL,
  "status" INTEGER DEFAULT 0 NOT NULL,
  "reason" VARCHAR(255) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sdo_oid_id" ON "store_delivery_order" ("oid", "id");
CREATE INDEX IF NOT EXISTS "sdo_uid_id" ON "store_delivery_order" ("uid", "id");
CREATE INDEX IF NOT EXISTS "sdo_order_id" ON "store_delivery_order" ("order_id");
CREATE INDEX IF NOT EXISTS "sdo_delivery_no" ON "store_delivery_order" ("delivery_no");
CREATE INDEX IF NOT EXISTS "sdo_owner_status"
  ON "store_delivery_order" ("type", "relation_id", "status", "id");
CREATE INDEX IF NOT EXISTS "sdo_status_time"
  ON "store_delivery_order" ("status", "add_time", "id");
CREATE INDEX IF NOT EXISTS "sos_oid_change_time"
  ON "store_order_status" ("oid", "change_time");
