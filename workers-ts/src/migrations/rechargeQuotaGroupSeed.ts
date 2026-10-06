/** External 0166 / embedded 0172: fixed empty metadata, never sample balances or offers. */
export const RECHARGE_QUOTA_GROUP_SEED_SQL = String.raw`-- Create only the fixed, empty recharge-quota metadata group when absent.
-- Existing unique metadata is preserved verbatim, including legacy fields text.
-- Run in one explicit maintenance transaction; never replay full bootstrap on upgrades.
SET LOCAL search_path TO pg_catalog, public, pg_temp;
SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true);
DO $recharge_quota_group_seed$
DECLARE
  group_oid oid;
  config_att smallint;
  existing_count integer;
  created_id integer;
  target_oid oid;
  sequence_oid oid;
  log_oid oid;
  data_oid oid;
  explicit_columns text[];
BEGIN
  IF current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'Recharge quota seed requires origin replication mode';
  END IF;
  group_oid := to_regclass('public.system_group');
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=group_oid AND c.relkind='r' AND c.relpersistence='p'
    AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND pg_has_role(current_user,c.relowner,'USAGE')
    AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid)) THEN
    RAISE EXCEPTION 'Recharge quota seed requires the owned system_group table';
  END IF;
  -- Same fence as quota administration and shared package-order snapshots.
  PERFORM pg_advisory_xact_lock(731642,1);
  LOCK TABLE ONLY public.system_group IN SHARE ROW EXCLUSIVE MODE;
  IF to_regclass('public.system_group') IS DISTINCT FROM group_oid
    OR NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=group_oid AND c.relkind='r' AND c.relpersistence='p'
      AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND pg_has_role(current_user,c.relowner,'USAGE')
      AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid)) THEN
    RAISE EXCEPTION 'Recharge quota seed table identity changed';
  END IF;
  SELECT count(*) INTO existing_count FROM (
    SELECT id FROM ONLY public.system_group WHERE config_name='user_recharge_quota' LIMIT 2
  ) bounded;
  IF existing_count>1 THEN RAISE EXCEPTION 'Duplicate recharge quota configuration groups require review'; END IF;
  -- The runtime consumers do not interpret fields metadata. Do not turn a
  -- previously usable group into a rejected upgrade or overwrite its labels.
  IF existing_count=1 THEN RETURN; END IF;
  -- No foreign key exists on gid. Freeze writers while proving that a newly
  -- allocated group id cannot silently adopt historical orphan quota rows.
  data_oid := to_regclass('public.system_group_data');
  LOCK TABLE ONLY public.system_group_data IN SHARE MODE;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=data_oid AND c.relkind='r' AND c.relpersistence='p'
    AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND pg_has_role(current_user,c.relowner,'USAGE')
    AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid)) THEN
    RAISE EXCEPTION 'Recharge quota seed requires the owned group data table';
  END IF;
  IF to_regclass('public.system_group_data') IS DISTINCT FROM data_oid THEN
    RAISE EXCEPTION 'Recharge quota seed data table identity changed';
  END IF;
  log_oid := to_regclass('public.system_log');
  LOCK TABLE ONLY public.system_log IN SHARE ROW EXCLUSIVE MODE;
  IF to_regclass('public.system_log') IS DISTINCT FROM log_oid THEN
    RAISE EXCEPTION 'Recharge quota seed audit table identity changed';
  END IF;
  -- A one-row seed must not dispatch unrelated trigger/rule/default effects.
  FOREACH target_oid IN ARRAY ARRAY[group_oid,log_oid] LOOP
    explicit_columns := CASE WHEN target_oid=group_oid THEN ARRAY['id','cate_id','name','info','config_name','fields']
      ELSE ARRAY['id','store_id','admin_id','admin_name','path','page','method','action','ip','type','add_time','merchant_id'] END;
    IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=target_oid AND c.relkind='r' AND c.relpersistence='p'
      AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND pg_has_role(current_user,c.relowner,'USAGE')
      AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid))
      OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=target_oid AND NOT tgisinternal AND tgenabled<>'D')
      OR EXISTS (SELECT 1 FROM pg_rewrite WHERE ev_class=target_oid)
      OR EXISTS (SELECT 1 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=target_oid AND NOT a.attisdropped AND a.attnum>0
          AND (a.attgenerated<>'' OR (NOT a.attname=ANY(explicit_columns) AND (a.attidentity<>'' OR d.oid IS NOT NULL)))) THEN
      RAISE EXCEPTION 'Recharge quota seed target side effects require review';
    END IF;
    sequence_oid := pg_get_serial_sequence(target_oid::regclass::text,'id')::regclass;
    IF sequence_oid IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      JOIN pg_class seq ON seq.oid=sequence_oid JOIN pg_class t ON t.oid=a.attrelid
      WHERE a.attrelid=target_oid AND a.attname='id' AND a.atttypid='integer'::regtype AND a.attnotnull AND NOT a.attisdropped
        AND a.attidentity='' AND seq.relkind='S' AND seq.relowner=t.relowner
        AND pg_get_expr(d.adbin,d.adrelid)='nextval(''' || sequence_oid::regclass::text || '''::regclass)'
        AND EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=target_oid AND i.indisprimary AND i.indisunique
          AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
          AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indkey[0]=a.attnum AND i.indpred IS NULL AND i.indexprs IS NULL)
    ) THEN RAISE EXCEPTION 'Recharge quota seed serial default requires review'; END IF;
  END LOOP;
  SELECT attnum INTO config_att FROM pg_attribute WHERE attrelid=group_oid AND attname='config_name'
    AND atttypid='varchar'::regtype AND atttypmod=54 AND attnotnull AND NOT attisdropped;
  IF config_att IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am a ON a.oid=c.relam
    WHERE i.indrelid=group_oid AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
      AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indkey[0]=config_att AND i.indpred IS NULL AND i.indexprs IS NULL
      AND a.amname='btree'
  ) THEN RAISE EXCEPTION 'Recharge quota seed requires the config_name unique index'; END IF;
  INSERT INTO public.system_group(cate_id,name,info,config_name,fields)
  VALUES(0,'充值金额设置','设置充值金额额度选择','user_recharge_quota',
    '[{"name":"售价","title":"price","type":"input","param":""},{"name":"赠送","title":"give_money","type":"input","param":""}]')
  RETURNING id INTO created_id;
  IF EXISTS(SELECT 1 FROM ONLY public.system_group_data WHERE gid=created_id LIMIT 1) THEN
    RAISE EXCEPTION 'Recharge quota seed would adopt orphan group data; review the sequence and orphan rows';
  END IF;
  -- A migration actor is deliberately 0, never a fabricated administrator.
  -- No amount, gift, user balance, payment switch or business row is seeded.
  INSERT INTO public.system_log(store_id,admin_id,admin_name,path,page,method,action,ip,type,add_time,merchant_id)
  VALUES(0,0,'','/migration/0166/recharge-quota-group','','MIGRATE',
    'initialize;group_id=' || created_id::text || ';version=1','','recharge_quota_seed',floor(extract(epoch FROM clock_timestamp()))::integer,0);
END
$recharge_quota_group_seed$;`;
