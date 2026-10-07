/** Explicit owner installation outside the pinned historical migration cohort. */
export const WECOM_CHANNEL_CHECK_DEFINITION = "CHECK (((channel)::text = ANY ((ARRAY['sms'::character varying, 'wechat_official'::character varying, 'wechat_routine'::character varying, 'wechat_shipping'::character varying, 'wecom_robot'::character varying])::text[])))";
export const WITHDRAWAL_WECOM_ROBOT_CHANNEL_SQL = String.raw`-- Run as a separate owner maintenance transaction before enabling robot delivery.
-- No business rows, provider credentials, roles or grants change.
SET LOCAL search_path TO pg_catalog, public, pg_temp;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
DO $withdrawal_wecom_channel$
DECLARE
  definition text;
  old_definition constant text := 'CHECK (((channel)::text = ANY ((ARRAY[''sms''::character varying, ''wechat_official''::character varying, ''wechat_routine''::character varying, ''wechat_shipping''::character varying])::text[])))';
  new_definition constant text := '${WECOM_CHANNEL_CHECK_DEFINITION.replaceAll("'", "''")}';
  row_count integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('public.order_notification_delivery')
    AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
    AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid))
    OR EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Withdrawal WeCom delivery prerequisite drift; no automatic repair';
  END IF;
  LOCK TABLE ONLY public.order_notification_delivery IN ACCESS EXCLUSIVE MODE NOWAIT;
  SELECT pg_get_constraintdef(c.oid) INTO definition FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname='channel'
    WHERE c.conrelid='public.order_notification_delivery'::regclass AND c.conname='ond_channel_ck'
      AND c.contype='c' AND c.convalidated AND NOT c.connoinherit AND c.conislocal AND c.coninhcount=0
      AND c.conkey=ARRAY[a.attnum]::smallint[] AND a.atttypid='varchar'::regtype AND a.atttypmod=36
      AND a.attnotnull AND a.attgenerated='' AND a.attidentity='' AND NOT a.attisdropped;
  IF definition = new_definition THEN RETURN; END IF;
  IF definition IS DISTINCT FROM old_definition THEN
    RAISE EXCEPTION 'Withdrawal WeCom delivery CHECK drift; no automatic repair';
  END IF;
  SELECT count(*) INTO row_count FROM (SELECT 1 FROM public.order_notification_delivery LIMIT 10001) bounded;
  IF row_count>10000 THEN RAISE EXCEPTION 'Withdrawal WeCom delivery maintenance row budget exceeded'; END IF;
  ALTER TABLE public.order_notification_delivery DROP CONSTRAINT ond_channel_ck;
  ALTER TABLE public.order_notification_delivery ADD CONSTRAINT ond_channel_ck
    CHECK (channel IN ('sms', 'wechat_official', 'wechat_routine', 'wechat_shipping', 'wecom_robot'));
END
$withdrawal_wecom_channel$;
`;
