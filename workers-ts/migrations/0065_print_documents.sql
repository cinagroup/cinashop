-- Preserve both generations of receipt-printer configuration from the PHP
-- schema. supplier_ticket_print is superseded historical configuration;
-- print_document is the active printer-definition authority. Source rows are
-- retained without inventing uniqueness or foreign-key rules.
CREATE TABLE IF NOT EXISTS "supplier_ticket_print" (
  "id" SERIAL PRIMARY KEY,
  "supplier_id" INTEGER DEFAULT 0 NOT NULL,
  "develop_id" INTEGER DEFAULT 0 NOT NULL,
  "api_key" VARCHAR(100) DEFAULT '' NOT NULL,
  "client_id" VARCHAR(100) DEFAULT '' NOT NULL,
  "terminal_number" VARCHAR(100) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "supplier_ticket_print_supplier_id"
  ON "supplier_ticket_print" ("supplier_id");

CREATE TABLE IF NOT EXISTS "print_document" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "supplier_id" INTEGER DEFAULT 0 NOT NULL,
  "print_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "yly_user_id" VARCHAR(255) DEFAULT '' NOT NULL,
  "yly_app_id" VARCHAR(255) DEFAULT '' NOT NULL,
  "yly_app_secret" VARCHAR(255) DEFAULT '' NOT NULL,
  "yly_sn" VARCHAR(255) DEFAULT '' NOT NULL,
  "fey_user" VARCHAR(255) DEFAULT '' NOT NULL,
  "fey_ukey" VARCHAR(255) DEFAULT '' NOT NULL,
  "fey_sn" VARCHAR(255) DEFAULT '' NOT NULL,
  "times" INTEGER DEFAULT 0 NOT NULL,
  "print_type" SMALLINT DEFAULT 1 NOT NULL,
  "print_content" TEXT,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "print_document_supplier_id"
  ON "print_document" ("supplier_id", "id");
CREATE INDEX IF NOT EXISTS "print_document_active_lookup"
  ON "print_document" ("supplier_id", "is_del", "status", "print_type", "id");
