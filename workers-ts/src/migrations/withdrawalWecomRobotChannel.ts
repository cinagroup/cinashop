/** Explicit owner installation outside the pinned historical migration cohort. */
export const WECOM_CHANNEL_CHECK_DEFINITION = "CHECK (((channel)::text = ANY ((ARRAY['sms'::character varying, 'wechat_official'::character varying, 'wechat_routine'::character varying, 'wechat_shipping'::character varying, 'wecom_robot'::character varying])::text[])))";
export interface WithdrawalWecomMaintenanceTarget {
  expectedDatabase: string;
  expectedMaintenanceRole: string;
}

/** Reviewed literal identities are mandatory; the returned SQL cannot run against an arbitrary catalog. */
export function withdrawalWecomRobotChannelSql(target: WithdrawalWecomMaintenanceTarget): string {
  const identifier = /^[a-z_][a-z0-9_]{0,62}$/;
  if (!identifier.test(target.expectedDatabase) || !identifier.test(target.expectedMaintenanceRole)) {
    throw new Error("Withdrawal WeCom maintenance identity is invalid");
  }
  return String.raw`-- Run as a separate owner maintenance transaction before enabling robot delivery.
-- No business rows, provider credentials, roles or grants change.
SET LOCAL search_path TO pg_catalog, public, pg_temp;
SET LOCAL row_security = off;
SELECT set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000),5000)::text || 'ms',true),
  set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000),1000)::text || 'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text || 'ms',true);
DO $withdrawal_wecom_channel$
DECLARE
  definition text;
  old_definition constant text := 'CHECK (((channel)::text = ANY ((ARRAY[''sms''::character varying, ''wechat_official''::character varying, ''wechat_routine''::character varying, ''wechat_shipping''::character varying])::text[])))';
  new_definition constant text := '${WECOM_CHANNEL_CHECK_DEFINITION.replaceAll("'", "''")}';
  row_count integer;
BEGIN
  IF current_database() <> '${target.expectedDatabase}'
    OR session_user <> '${target.expectedMaintenanceRole}' OR current_user <> session_user
    OR current_setting('server_version_num')::integer / 10000 <> 16
    OR current_setting('transaction_isolation') <> 'read committed'
    OR current_setting('transaction_read_only') <> 'off'
    OR pg_is_in_recovery()
    OR current_setting('search_path') <> 'pg_catalog, public, pg_temp'
    OR current_setting('row_security') <> 'off'
    OR current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'Withdrawal WeCom delivery requires exact PG16 read-write maintenance identity';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('public.order_notification_delivery')
    AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
    AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='${target.expectedMaintenanceRole}')
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
}
