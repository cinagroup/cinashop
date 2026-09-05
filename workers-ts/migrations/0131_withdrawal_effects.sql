ALTER TABLE "capital_flow" ADD COLUMN IF NOT EXISTS "event_key" VARCHAR(128);
CREATE UNIQUE INDEX IF NOT EXISTS "cf_event_key_uq" ON "capital_flow" ("event_key");

ALTER TABLE "order_notification_delivery" ADD COLUMN IF NOT EXISTS "withdrawal_id" INTEGER;
ALTER TABLE "order_notification_delivery" ALTER COLUMN "order_id" DROP NOT NULL;
ALTER TABLE "order_notification_delivery" DROP CONSTRAINT IF EXISTS "ond_subject_ck";
ALTER TABLE "order_notification_delivery" ADD CONSTRAINT "ond_subject_ck" CHECK (
  ("withdrawal_id" IS NULL AND "order_id" IS NOT NULL)
  OR ("withdrawal_id" IS NOT NULL AND "withdrawal_id" > 0 AND "order_id" IS NULL)
);
CREATE INDEX IF NOT EXISTS "ond_withdrawal"
  ON "order_notification_delivery" ("withdrawal_id", "id") WHERE "withdrawal_id" IS NOT NULL;

ALTER TABLE "store_order_outbox" DROP CONSTRAINT IF EXISTS "soob_event_type_ck";
ALTER TABLE "store_order_outbox" ADD CONSTRAINT "soob_event_type_ck" CHECK (
  "event_type" IN ('order.paid', 'order.delivery.notice', 'order.refund.refused.notice',
    'order.second_card.advent.notice', 'order.second_card.expired.notice',
    'withdrawal.approved.notice', 'withdrawal.refused.notice')
);
