-- Durable, idempotent in-app delivery/refund notices.
-- Legacy system_message rows remain NULL and are therefore unaffected by the
-- unique source-event key used by new Worker outbox consumers.
ALTER TABLE "system_message"
  ADD COLUMN IF NOT EXISTS "event_key" VARCHAR(128);

CREATE UNIQUE INDEX IF NOT EXISTS "smsg_event_key_uq"
  ON "system_message" ("event_key");

-- Expand the existing payment-only outbox without weakening its event whitelist.
ALTER TABLE "store_order_outbox"
  DROP CONSTRAINT IF EXISTS "soob_event_type_ck";

ALTER TABLE "store_order_outbox"
  ADD CONSTRAINT "soob_event_type_ck" CHECK (
    "event_type" IN (
      'order.paid',
      'order.delivery.notice',
      'order.refund.refused.notice'
    )
  );
