-- Supplier onboarding applications and SMS delivery audit rows from the PHP
-- schema. Historical rows retain their source shape; indexes only support the
-- authenticated runtime access paths and do not add uniqueness or foreign keys.
CREATE TABLE IF NOT EXISTS "system_user_apply" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "phone" VARCHAR(20) DEFAULT '' NOT NULL,
  "system_name" VARCHAR(30) DEFAULT '' NOT NULL,
  "name" VARCHAR(30) DEFAULT '' NOT NULL,
  "images" VARCHAR(2000) DEFAULT '' NOT NULL,
  "mark" VARCHAR(255) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "fail_msg" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "status_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_user_apply_owner_lookup"
  ON "system_user_apply" ("uid", "type", "is_del", "id");
CREATE INDEX IF NOT EXISTS "system_user_apply_review_lookup"
  ON "system_user_apply" ("type", "is_del", "status", "id");
CREATE INDEX IF NOT EXISTS "system_user_apply_relation_lookup"
  ON "system_user_apply" ("relation_id", "type", "is_del");

CREATE TABLE IF NOT EXISTS "sms_record" (
  "id" SERIAL PRIMARY KEY,
  "uid" VARCHAR(255) DEFAULT '' NOT NULL,
  "phone" CHAR(11) DEFAULT '' NOT NULL,
  "content" TEXT,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "add_ip" VARCHAR(16) DEFAULT '' NOT NULL,
  "template" VARCHAR(255) DEFAULT '' NOT NULL,
  "resultcode" INTEGER DEFAULT 0 NOT NULL,
  "record_id" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sms_record_phone_time"
  ON "sms_record" ("phone", "add_time", "id");
CREATE INDEX IF NOT EXISTS "sms_record_ip_time"
  ON "sms_record" ("add_ip", "add_time", "id");
CREATE INDEX IF NOT EXISTS "sms_record_result_time"
  ON "sms_record" ("resultcode", "add_time", "id");
