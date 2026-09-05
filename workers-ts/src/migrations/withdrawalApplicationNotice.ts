/** Mirrored by 0132_withdrawal_application_notice.sql; apply only after explicit production DDL approval. */
export const WITHDRAWAL_APPLICATION_NOTICE_SQL = `
ALTER TABLE "store_order_outbox" DROP CONSTRAINT IF EXISTS "soob_event_type_ck";
ALTER TABLE "store_order_outbox" ADD CONSTRAINT "soob_event_type_ck" CHECK (
  "event_type" IN ('order.paid', 'order.delivery.notice', 'order.refund.refused.notice',
    'order.second_card.advent.notice', 'order.second_card.expired.notice',
    'withdrawal.approved.notice', 'withdrawal.refused.notice', 'withdrawal.applied.notice')
);
CREATE INDEX IF NOT EXISTS "smsg_staff_inbox" ON "system_message" ("user_id", "id")
  WHERE "type" = 2 AND "status" = 1 AND "is_del" = 0;
`;
