-- Preserve the PHP third-party API identity and documentation catalog without
-- promoting its plaintext credential copies or arbitrary outbound push URLs
-- into Worker runtime authorities.
CREATE TABLE IF NOT EXISTS "out_account" (
  "id" SERIAL PRIMARY KEY,
  "appid" VARCHAR(50) DEFAULT '' NOT NULL,
  "appsecret" VARCHAR(100) DEFAULT '' NOT NULL,
  "apppwd" VARCHAR(100) DEFAULT '' NOT NULL,
  "title" VARCHAR(200) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "rules" TEXT,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "last_time" INTEGER DEFAULT 0 NOT NULL,
  "ip" VARCHAR(30) DEFAULT '' NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "push_open" SMALLINT DEFAULT 0 NOT NULL,
  "push_account" VARCHAR(255) DEFAULT '' NOT NULL,
  "push_password" VARCHAR(255) DEFAULT '' NOT NULL,
  "push_token_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "user_update_push" VARCHAR(255) DEFAULT '' NOT NULL,
  "order_create_push" VARCHAR(255) DEFAULT '' NOT NULL,
  "order_pay_push" VARCHAR(255) DEFAULT '' NOT NULL,
  "refund_create_push" VARCHAR(255) DEFAULT '' NOT NULL,
  "refund_cancel_push" VARCHAR(255) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "out_account_active_appid"
  ON "out_account" ("appid", "id") WHERE "is_del" = 0;
CREATE INDEX IF NOT EXISTS "out_account_status_time"
  ON "out_account" ("is_del", "status", "add_time", "id");

CREATE TABLE IF NOT EXISTS "out_interface" (
  "id" SERIAL PRIMARY KEY,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "describe" TEXT,
  "method" VARCHAR(255) DEFAULT '' NOT NULL,
  "url" VARCHAR(255) DEFAULT '' NOT NULL,
  "request_params" TEXT,
  "return_params" TEXT,
  "request_example" TEXT,
  "return_example" TEXT,
  "error_code" TEXT,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "out_interface_active_tree"
  ON "out_interface" ("pid", "id") WHERE "is_del" = 0;
CREATE INDEX IF NOT EXISTS "out_interface_active_route"
  ON "out_interface" ("method", "url", "id") WHERE "is_del" = 0;
