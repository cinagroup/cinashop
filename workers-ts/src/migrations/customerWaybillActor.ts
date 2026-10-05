/** Separate reviewed owner forward, never startup/runAll or CHECK disabling. */
export const CUSTOMER_WAYBILL_ACTOR_SQL = `
ALTER TABLE public.order_waybill_job ADD COLUMN actor_service_id integer NOT NULL DEFAULT 0;
ALTER TABLE public.order_waybill_job_action ADD COLUMN actor_service_id integer NOT NULL DEFAULT 0;
ALTER TABLE public.order_waybill_job DROP CONSTRAINT owj_actor_ck;
ALTER TABLE public.order_waybill_job_action DROP CONSTRAINT owja_actor_ck;
ALTER TABLE public.order_waybill_job ADD CONSTRAINT owj_actor_ck CHECK (
 actor_id>0 AND supplier_id>=0 AND ((actor_type IN ('admin','supplier') AND actor_service_id=0)
 OR (actor_type='customer' AND actor_service_id>0)));
ALTER TABLE public.order_waybill_job_action ADD CONSTRAINT owja_actor_ck CHECK (
 actor_id>0 AND supplier_id>=0 AND ((actor_type IN ('admin','supplier') AND actor_service_id=0)
 OR (actor_type='customer' AND actor_service_id>0)));
`;
