/** Explicit PG16 storage installation and controlled old-column widening.
 * Installs the fixed-purpose source lock owner-only; no business-row adoption,
 * runtime grants, startup hook or ACL repair. */
import type { DbClient } from '@/lib/di';
import { RECHARGE_REFUND_GATE, RECHARGE_REFUND_SCHEMA_SQL } from './rechargeRefundContract';
import { RECHARGE_REFUND_CATALOG_SQL } from './rechargeRefundCatalog';

export const RECHARGE_REFUND_INSTALLATION_SQL = `
-- 0203 deliberately widens only user_recharge.refund_price numeric(10,2) to
-- numeric(12,2). Both scales are 2; the built-in numeric widening has no USING
-- expression and preserves every value. Existing owner/ACL/comments, relation
-- and column identity, other columns and indexes are compared under one lock.
SET LOCAL search_path TO pg_catalog,public,pg_temp;
SET LOCAL row_security TO off;
SET LOCAL standard_conforming_strings TO on;
SELECT set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),30000),30000)::text||'ms',true),
 set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000),1000)::text||'ms',true),
 set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true);
DO $recharge_refund_install$
DECLARE before_state record; after_state record; original_source jsonb;
 inspection_sql constant text := $recharge_refund_inspection$${RECHARGE_REFUND_CATALOG_SQL}$recharge_refund_inspection$;
BEGIN
 IF current_setting('server_version_num')::integer/10000<>16 OR current_user<>session_user
  OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off'
  OR current_setting('search_path')<>'pg_catalog, public, pg_temp' OR current_setting('row_security')<>'off'
  OR current_setting('session_replication_role')<>'origin'
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper AND rolcanlogin)
  OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
  RAISE EXCEPTION 'Recharge refund installation requires a direct PG16 maintenance owner READ COMMITTED transaction';
 END IF;
 IF NOT pg_try_advisory_xact_lock(${RECHARGE_REFUND_GATE[0]},${RECHARGE_REFUND_GATE[1]}) THEN
  RAISE EXCEPTION 'Recharge refund installation already running';
 END IF;
 IF to_regclass('public.user_recharge') IS NULL OR to_regclass('user_recharge') IS DISTINCT FROM to_regclass('public.user_recharge') THEN
  RAISE EXCEPTION 'Recharge refund requires the existing public recharge table';
 END IF;
 LOCK TABLE ONLY public.user_recharge IN ACCESS EXCLUSIVE MODE NOWAIT;
 EXECUTE inspection_sql INTO before_state;
 IF before_state.source_safe IS DISTINCT FROM true
  OR before_state.maintenance_oid IS DISTINCT FROM (SELECT oid::text FROM pg_roles WHERE rolname=current_user) THEN
  RAISE EXCEPTION 'Recharge refund source column/owner drift';
 END IF;
 IF before_state.present THEN
  IF before_state.structural IS DISTINCT FROM true OR before_state.source->>'type'<>'numeric(12,2)'
   OR NOT (before_state.owner_only OR (before_state.binding_safe AND before_state.commissioned_acl))
   OR NOT (before_state.unbound OR before_state.binding_safe) THEN
   RAISE EXCEPTION 'Recharge refund namespace is partial or its catalog/ACL/binding has drifted';
  END IF;
  LOCK TABLE ONLY public.recharge_refund_operation,ONLY public.recharge_refund_attempt,
   ONLY public.recharge_refund_result,ONLY public.recharge_refund_state IN ACCESS EXCLUSIVE MODE NOWAIT;
 END IF;
 original_source:=before_state.source;
 IF before_state.source->>'type'='numeric(10,2)' THEN
  ALTER TABLE ONLY public.user_recharge ALTER COLUMN refund_price TYPE numeric(12,2);
 END IF;
 IF NOT before_state.present THEN
${RECHARGE_REFUND_SCHEMA_SQL}
 END IF;
 EXECUTE inspection_sql INTO after_state;
 IF after_state.structural IS DISTINCT FROM true OR after_state.source->>'type'<>'numeric(12,2)'
  OR NOT (after_state.owner_only OR (after_state.binding_safe AND after_state.commissioned_acl))
  OR NOT (after_state.unbound OR after_state.binding_safe) THEN
  RAISE EXCEPTION 'Recharge refund catalog/ACL/binding failed after lock/create';
 END IF;
 IF (after_state.source-'type') IS DISTINCT FROM (original_source-'type') THEN
  RAISE EXCEPTION 'Recharge refund widening changed existing source identity/metadata';
 END IF;
 IF current_user<>session_user OR current_setting('session_replication_role')<>'origin'
  OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
  RAISE EXCEPTION 'Recharge refund installation environment changed';
 END IF;
END
$recharge_refund_install$;
`;

/** Caller invokes explicitly, using a root postgres-js client. No SQL is run by
 * importing this module. A late failure rolls back the widening and all new DDL. */
export async function runRechargeRefundInstallation(db:Pick<DbClient,'$client'>):Promise<void> {
 if(!db.$client)throw Error('Recharge refund installation requires a root database');
 await db.$client.begin('isolation level read committed',async tx=>{await tx.unsafe(RECHARGE_REFUND_INSTALLATION_SQL);});
}
