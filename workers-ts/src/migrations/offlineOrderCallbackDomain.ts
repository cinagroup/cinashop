/** Unregistered follow-on candidate, after all four offline finance candidates.
 * Explicit ALTER, never mutate the deployed 0120/0121 migrations or silently
 * skip an unexpected catalog. Controlled installer/catalog/ACL gate is pending.
 */
export const OFFLINE_ORDER_CALLBACK_DOMAIN_SQL = `
ALTER TABLE public.payment_callback_event DROP CONSTRAINT pce_order_domain_ck;
ALTER TABLE public.payment_callback_event ADD CONSTRAINT pce_order_domain_ck
  CHECK(order_domain IN ('','store_order','recharge','membership','offline_order'));
ALTER TABLE public.payment_reconciliation_case DROP CONSTRAINT prc_order_domain_ck;
ALTER TABLE public.payment_reconciliation_case ADD CONSTRAINT prc_order_domain_ck
  CHECK(order_domain IN ('','store_order','recharge','membership','offline_order'));
`;
