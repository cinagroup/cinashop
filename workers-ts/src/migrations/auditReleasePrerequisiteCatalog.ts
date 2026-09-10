import type { DbClient } from '../lib/di';

export interface ReleasePrerequisiteCatalog {
  serverMajor: number;
  schemaPresent: boolean;
  tables: Array<{ name: string; exists: boolean; kind: string | null; rls: boolean | null }>;
  columns: Array<{ table: string; name: string; exists: boolean; type: string | null; notNull: boolean | null; defaultHash: string | null }>;
  indexes: Array<{ name: string; exists: boolean; table: string | null; unique: boolean | null; valid: boolean | null; ready: boolean | null; definition: string | null; truncated: boolean | null }>;
  constraints: Array<{ table: string; name: string; exists: boolean; validated: boolean | null; definition: string | null; truncated: boolean | null }>;
  functions: Array<{ name: string; exists: boolean; securityDefiner: boolean | null; sourceHash: string | null }>;
  triggers: Array<{ table: string; name: string; exists: boolean; enabled: string | null; definition: string | null; truncated: boolean | null }>;
  reachableRoleAttributes: { superuser: boolean; createDb: boolean; createRole: boolean; replication: boolean; bypassRls: boolean };
}

/** Fixed public-catalog inventory for DB-006/007, 0134, 0146-0149 and two checkout fences.
 * No business rows, routine bodies, role names or user-provided SQL/schema.
 * Presence and readable definitions are evidence, NOT a ready-to-deploy verdict.
 * In particular this does not attest the 0135-0145 alignment migrations.
 */
export async function auditReleasePrerequisiteCatalog(db: Pick<DbClient, '$client'>): Promise<ReleasePrerequisiteCatalog> {
  if (!db.$client) throw new Error('Release catalog audit requires a root database');
  return db.$client.begin('isolation level repeatable read read only', async tx => {
    await tx`SELECT
      pg_catalog.set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
      pg_catalog.set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`;
    const [row] = await tx<{ catalog: ReleasePrerequisiteCatalog }[]>`
      WITH ns AS (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname='public'),
      selected_tables(name) AS (VALUES ('user'),('store_order'),('user_extract'),('capital_flow'),
        ('order_notification_delivery'),('store_order_outbox'),('system_message'),('store_coupon_issue'),('store_coupon_product'),
        ('store_product_category'),('store_order_refund'),('payment_reconciliation_case'),('store_product_reply'),
        ('work_contact_action_outbox'),('store_cart')),
      selected_columns(table_name,name) AS (VALUES
        ('user_extract','request_key'),('user_extract','request_hash'),('user_extract','wechat'),
        ('capital_flow','event_key'),('order_notification_delivery','withdrawal_id'),('order_notification_delivery','order_id'),
        ('user','add_ip'),('user','last_ip'),('store_order','user_ip'),('store_product_category','pic'),('store_cart','bargain_user_id')),
      selected_indexes(name) AS (VALUES ('ue_request_replay_uq'),('cf_event_key_uq'),('ond_withdrawal'),('smsg_staff_inbox'),
        ('sor_pink_recovery_scan'),('prc_callback_event'),('spr_order_cart_info'),('wcao_client_ref')),
      selected_constraints(table_name,name) AS (VALUES ('order_notification_delivery','ond_subject_ck'),('store_order_outbox','soob_event_type_ck'),
        ('store_cart','sc_bargain_participation_ck')),
      selected_functions(name) AS (VALUES ('brokerage_paid_order_fence_0150'),('coupon_product_scope_fence_0151')),
      selected_triggers(table_name,name) AS (VALUES
        ('store_order','brokerage_paid_insert_0150'),('store_order','brokerage_paid_update_0150'),('store_order','brokerage_paid_delete_0150'),
        ('store_coupon_product','coupon_product_insert_0151'),('store_coupon_product','coupon_product_update_0151'),('store_coupon_product','coupon_product_delete_0151')),
      identities AS (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (current_user,session_user)
        UNION SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()
      ), reachable AS (
        SELECT r.* FROM pg_catalog.pg_roles r WHERE EXISTS (SELECT 1 FROM identities i
          WHERE pg_catalog.pg_has_role(i.oid,r.oid,'USAGE') OR pg_catalog.pg_has_role(i.oid,r.oid,'SET')
            OR pg_catalog.pg_has_role(i.oid,r.oid,'MEMBER WITH ADMIN OPTION'))
      )
      SELECT pg_catalog.jsonb_build_object(
        'serverMajor', current_setting('server_version_num')::integer / 10000,
        'schemaPresent', EXISTS(SELECT 1 FROM ns),
        'tables', (SELECT jsonb_agg(jsonb_build_object('name',s.name,'exists',c.oid IS NOT NULL,'kind',c.relkind,'rls',c.relrowsecurity) ORDER BY s.name)
          FROM selected_tables s LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=(SELECT oid FROM ns) AND c.relname=s.name),
        'columns', (SELECT jsonb_agg(jsonb_build_object('table',s.table_name,'name',s.name,'exists',a.attnum IS NOT NULL,
          'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,
          'defaultHash',pg_catalog.md5(pg_catalog.pg_get_expr(d.adbin,d.adrelid))) ORDER BY s.table_name,s.name)
          FROM selected_columns s LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=(SELECT oid FROM ns) AND c.relname=s.table_name
          LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname=s.name AND a.attnum>0 AND NOT a.attisdropped
          LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum),
        'indexes', (SELECT jsonb_agg(jsonb_build_object('name',s.name,'exists',i.indexrelid IS NOT NULL,
          'table',t.relname,'unique',i.indisunique,'valid',i.indisvalid,'ready',i.indisready,
          'definition',pg_catalog.left(pg_catalog.pg_get_indexdef(i.indexrelid),2048),
          'truncated',pg_catalog.length(pg_catalog.pg_get_indexdef(i.indexrelid))>2048) ORDER BY s.name)
          FROM selected_indexes s LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=(SELECT oid FROM ns) AND c.relname=s.name
          LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid LEFT JOIN pg_catalog.pg_class t ON t.oid=i.indrelid),
        'constraints', (SELECT jsonb_agg(jsonb_build_object('table',s.table_name,'name',s.name,'exists',con.oid IS NOT NULL,
          'validated',con.convalidated,'definition',pg_catalog.left(pg_catalog.pg_get_constraintdef(con.oid),2048),
          'truncated',pg_catalog.length(pg_catalog.pg_get_constraintdef(con.oid))>2048) ORDER BY s.table_name,s.name)
          FROM selected_constraints s LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=(SELECT oid FROM ns) AND c.relname=s.table_name
          LEFT JOIN pg_catalog.pg_constraint con ON con.conrelid=c.oid AND con.conname=s.name),
        'functions', (SELECT jsonb_agg(jsonb_build_object('name',s.name,'exists',p.oid IS NOT NULL,
          'securityDefiner',p.prosecdef,'sourceHash',pg_catalog.md5(p.prosrc)) ORDER BY s.name)
          FROM selected_functions s LEFT JOIN pg_catalog.pg_proc p ON p.pronamespace=(SELECT oid FROM ns) AND p.proname=s.name AND p.pronargs=0),
        'triggers', (SELECT jsonb_agg(jsonb_build_object('table',s.table_name,'name',s.name,'exists',tr.oid IS NOT NULL,
          'enabled',tr.tgenabled,'definition',pg_catalog.left(pg_catalog.pg_get_triggerdef(tr.oid),2048),
          'truncated',pg_catalog.length(pg_catalog.pg_get_triggerdef(tr.oid))>2048) ORDER BY s.table_name,s.name)
          FROM selected_triggers s LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=(SELECT oid FROM ns) AND c.relname=s.table_name
          LEFT JOIN pg_catalog.pg_trigger tr ON tr.tgrelid=c.oid AND tr.tgname=s.name AND NOT tr.tgisinternal),
        'reachableRoleAttributes', (SELECT jsonb_build_object('superuser',COALESCE(bool_or(rolsuper),false),
          'createDb',COALESCE(bool_or(rolcreatedb),false),'createRole',COALESCE(bool_or(rolcreaterole),false),
          'replication',COALESCE(bool_or(rolreplication),false),'bypassRls',COALESCE(bool_or(rolbypassrls),false)) FROM reachable)
      ) AS catalog`;
    if (!row) throw new Error('Release catalog query returned no result');
    return row.catalog;
  });
}
