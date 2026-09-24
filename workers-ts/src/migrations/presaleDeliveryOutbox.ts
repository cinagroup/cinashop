/** External 0161 / embedded 0167: bounded, forward-only event expansion. */
export const PRESALE_DELIVERY_OUTBOX_SQL = String.raw`-- Expand only the known event whitelist. No business rows, roles or privileges change.
-- Existing databases must use this standalone upgrade, never the full bootstrap.
SET LOCAL search_path TO pg_catalog, public, pg_temp;
SELECT set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
  set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
  set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true);
DO $presale_outbox$
DECLARE
  current_definition text;
  row_count integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('public.store_order_outbox')
      AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid))
    OR EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Presale outbox prerequisite drift; no automatic repair';
  END IF;
  LOCK TABLE ONLY public.store_order_outbox IN ACCESS EXCLUSIVE MODE NOWAIT;
  SELECT pg_get_constraintdef(c.oid) INTO current_definition
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname='event_type'
    WHERE c.conrelid='public.store_order_outbox'::regclass AND c.conname='soob_event_type_ck'
      AND c.contype='c' AND c.convalidated AND NOT c.connoinherit AND c.conislocal AND c.coninhcount=0
      AND c.conkey=ARRAY[a.attnum]::smallint[] AND a.atttypid='varchar'::regtype AND a.atttypmod=68
      AND a.attnotnull AND a.attgenerated='' AND NOT a.attisdropped;
  IF current_definition = 'CHECK (((event_type)::text = ANY ((ARRAY[''order.paid''::character varying, ''order.delivery.notice''::character varying, ''order.refund.refused.notice''::character varying, ''order.second_card.advent.notice''::character varying, ''order.second_card.expired.notice''::character varying, ''withdrawal.approved.notice''::character varying, ''withdrawal.refused.notice''::character varying, ''withdrawal.applied.notice''::character varying, ''withdrawal.staff.refresh''::character varying, ''order.presale.fulfillment''::character varying])::text[])))' THEN
    RETURN;
  END IF;
  IF current_definition IS DISTINCT FROM 'CHECK (((event_type)::text = ANY ((ARRAY[''order.paid''::character varying, ''order.delivery.notice''::character varying, ''order.refund.refused.notice''::character varying, ''order.second_card.advent.notice''::character varying, ''order.second_card.expired.notice''::character varying, ''withdrawal.approved.notice''::character varying, ''withdrawal.refused.notice''::character varying, ''withdrawal.applied.notice''::character varying, ''withdrawal.staff.refresh''::character varying])::text[])))' THEN
    RAISE EXCEPTION 'Presale outbox event CHECK drift; no automatic repair';
  END IF;
  SELECT count(*) INTO row_count FROM (SELECT 1 FROM public.store_order_outbox LIMIT 10001) bounded;
  IF row_count>10000 THEN RAISE EXCEPTION 'Presale outbox maintenance row budget exceeded'; END IF;
  ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_event_type_ck;
  ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK (
    event_type IN ('order.paid', 'order.delivery.notice', 'order.refund.refused.notice', 'order.second_card.advent.notice', 'order.second_card.expired.notice', 'withdrawal.approved.notice', 'withdrawal.refused.notice', 'withdrawal.applied.notice', 'withdrawal.staff.refresh', 'order.presale.fulfillment')
  );
END
$presale_outbox$;
`;
