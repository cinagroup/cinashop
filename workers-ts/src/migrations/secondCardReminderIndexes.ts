/** Exact DDL mirrored by migrations/0129_second_card_reminder_indexes.sql. */
export const SECOND_CARD_REMINDER_MIGRATION_SQL = `
ALTER TABLE "store_order_outbox"
  DROP CONSTRAINT IF EXISTS "soob_event_type_ck";

ALTER TABLE "store_order_outbox"
  ADD CONSTRAINT "soob_event_type_ck" CHECK (
    "event_type" IN (
      'order.paid',
      'order.delivery.notice',
      'order.refund.refused.notice',
      'order.second_card.advent.notice',
      'order.second_card.expired.notice'
    )
  );

CREATE INDEX IF NOT EXISTS "soci_second_card_advent_due"
  ON "store_order_cart_info" ("write_end", "id")
  WHERE "product_type" = 4
    AND "is_writeoff" = 0
    AND "is_advent_sms" = 0
    AND "write_start" > 0
    AND "write_end" > 0;

CREATE INDEX IF NOT EXISTS "soci_second_card_expired_due"
  ON "store_order_cart_info" ("write_end", "id")
  WHERE "product_type" = 4
    AND "is_writeoff" = 0
    AND "is_expire_sms" = 0
    AND "write_start" > 0
    AND "write_end" > 0;
`;
