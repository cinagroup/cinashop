ALTER TABLE "store_order_outbox" DROP CONSTRAINT IF EXISTS "soob_event_type_ck";
ALTER TABLE "store_order_outbox" ADD CONSTRAINT "soob_event_type_ck" CHECK (
  "event_type" IN ('order.paid', 'order.delivery.notice', 'order.refund.refused.notice',
    'order.second_card.advent.notice', 'order.second_card.expired.notice',
    'withdrawal.approved.notice', 'withdrawal.refused.notice', 'withdrawal.applied.notice',
    'withdrawal.staff.refresh')
);
