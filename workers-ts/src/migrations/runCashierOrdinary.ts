import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { HttpApiException } from '@/utils/errors';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { customerWorkCatalogSql } from './customerWorkCatalog';
import { CASHIER_ORDINARY_TABLES, CASHIER_ORDINARY_INSTALLATION_SQL } from './cashierOrdinary';
import { customerWorkScopeLockReadiness } from './runCustomerWorkScopeLock';
import { cashierSecondCardPromotionLockReadiness } from './cashierSecondCardPromotionLock';
import { auditCheckoutPricingLockRuntime } from './checkoutPricingLock';
import { inspectCashierOrdinarySourceRights } from './cashierOrdinarySourceRights';

/** Closed until the literal maintenance DDL has independently generated its
 * exact empty PG16 fixture digest. Never learn a pin from a runtime database. */
// Generated independently by the literal owner DDL on fresh registered PG16;
// production still requires all separate source, LOGIN, owner and ACL checks.
export const CASHIER_ORDINARY_CATALOG_SHA256 = 'c3045d4094b759d189876d4883c2c984ffd89e7f48cd99745da564ef20860ab3';
export const CASHIER_ORDINARY_CATALOG_SQL = `SELECT jsonb_build_object(
 'tables',jsonb_build_object(${CASHIER_ORDINARY_TABLES.map(table => `'${table}',(${customerWorkCatalogSql(table).replace(' AS shape FROM', ' FROM')})`).join(',')}),
 'dropped_columns',(SELECT count(*) FROM pg_catalog.pg_attribute WHERE attnum>0 AND attisdropped AND attrelid IN(${CASHIER_ORDINARY_TABLES.map(t=>`to_regclass('public.${t}')`).join(',')})),
 'inbound_foreign_keys',(SELECT jsonb_agg(jsonb_build_object('table',k.conrelid::regclass::text,'name',k.conname,'definition',pg_catalog.pg_get_constraintdef(k.oid)) ORDER BY k.conrelid::regclass::text,k.conname)
  FROM pg_catalog.pg_constraint k WHERE k.confrelid IN(${CASHIER_ORDINARY_TABLES.map(t=>`to_regclass('public.${t}')`).join(',')})),
 'function',(SELECT jsonb_build_object('definition',pg_get_functiondef(p.oid),'name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),'result',pg_get_function_result(p.oid),
  'kind',p.prokind,'language',l.lanname,'trusted',l.lanpltrusted,'security_definer',p.prosecdef,'volatile',p.provolatile,'parallel',p.proparallel,
  'leakproof',p.proleakproof,'strict',p.proisstrict,'set_result',p.proretset,'source',p.prosrc,'config',p.proconfig,'support',p.prosupport::text,
  'binary',p.probin,'sql_body',p.prosqlbody::text,'cost',p.procost,'rows',p.prorows,'variadic',p.provariadic::text,'default_count',p.pronargdefaults,
  'all_argument_types',p.proallargtypes::text,'argument_modes',p.proargmodes,'argument_names',p.proargnames,'defaults',p.proargdefaults::text,'transform_types',p.protrftypes::text)
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure('public.protect_cashier_ordinary_v1()')),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('table',t.tgrelid::regclass::text,'name',CASE WHEN t.tgisinternal THEN NULL ELSE t.tgname END,'type',t.tgtype,
  'enabled',t.tgenabled,'internal',t.tgisinternal,'argument_count',t.tgnargs,'arguments',pg_catalog.encode(t.tgargs,'hex'),'columns',t.tgattr::text,
  'condition',pg_catalog.pg_get_expr(t.tgqual,t.tgrelid),'deferrable',t.tgdeferrable,'initially_deferred',t.tginitdeferred,'constraint',k.conname,
  'old_table',t.tgoldtable,'new_table',t.tgnewtable,'has_parent',t.tgparentid<>0,'routine',n.nspname||'.'||p.proname,'routine_arguments',pg_catalog.pg_get_function_identity_arguments(p.oid))
  ORDER BY t.tgrelid::regclass::text,p.proname,t.tgtype,k.conname,t.tgisinternal,CASE WHEN t.tgisinternal THEN '' ELSE t.tgname END)
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  LEFT JOIN pg_catalog.pg_constraint k ON k.oid=t.tgconstraint WHERE t.tgrelid IN(${CASHIER_ORDINARY_TABLES.map(t=>`to_regclass('public.${t}')`).join(',')}) OR p.oid=to_regprocedure('public.protect_cashier_ordinary_v1()')),
 'policy_count',(SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid IN(${CASHIER_ORDINARY_TABLES.map(t => `to_regclass('public.${t}')`).join(',')}))
 ) AS shape,current_setting('server_version_num')::integer AS server_version_num`;
export async function inspectCashierOrdinary(db: Pick<DbClient, 'execute'>) {
  const rows = await db.execute<{ shape: unknown; server_version_num: number }>(sql.raw(CASHIER_ORDINARY_CATALOG_SQL));
  const fingerprint = rows.length === 1 ? await outRequestHash(rows[0].shape) : null;
  return { complete: rows.length === 1 && Math.floor(rows[0].server_version_num / 10000) === 16
    && /^[a-f0-9]{64}$/.test(CASHIER_ORDINARY_CATALOG_SHA256) && fingerprint === CASHIER_ORDINARY_CATALOG_SHA256, fingerprint };
}
export async function cashierOrdinaryReadiness(db: Pick<DbClient, 'execute'>) {
  const catalog = await inspectCashierOrdinary(db);
  if (!catalog.complete) return { ready: false, reason: 'cashier_ordinary_catalog_not_commissioned', catalog };
  const scope = await customerWorkScopeLockReadiness(db), promotion = await cashierSecondCardPromotionLockReadiness(db);
  if (!scope.ready || !promotion.ready) return { ready: false, reason: scope.reason || promotion.reason, catalog };
  const pricing=await auditCheckoutPricingLockRuntime(db,'public','customer-work-ordinary'),source=await inspectCashierOrdinarySourceRights(db);
  if(!pricing.ready||!source.ready)return{ready:false,reason:!pricing.ready?'cashier_ordinary_pricing_authority_unreviewed':'cashier_ordinary_source_privileges_incomplete',catalog};
  const [rights] = await db.execute<{ ready: boolean }>(sql`
    WITH RECURSIVE authority(oid) AS(SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN(current_user,session_user)
    UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN authority a ON a.oid=m.member),
    realms AS(SELECT c.* FROM pg_catalog.pg_class c WHERE c.oid IN(${sql.join(CASHIER_ORDINARY_TABLES.map(t => sql`to_regclass(${`public.${t}`})`), sql`,`)}))
    SELECT current_user=session_user AND (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname=current_user)
    AND (SELECT count(*)=4 AND count(DISTINCT relowner)=1 AND bool_and(has_table_privilege(current_user,oid,'SELECT') AND has_table_privilege(current_user,oid,'INSERT')) FROM realms)
    AND NOT EXISTS(SELECT 1 FROM authority a JOIN pg_catalog.pg_roles r ON r.oid=a.oid
      WHERE r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls
      OR has_schema_privilege(r.oid,'public','CREATE') OR has_database_privilege(r.oid,current_database(),'CREATE')
      OR has_parameter_privilege(r.oid,'session_replication_role','SET') OR has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM'))
    AND NOT EXISTS(SELECT 1 FROM authority a JOIN realms c ON c.relowner=a.oid
      OR has_table_privilege(a.oid,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(a.oid,c.oid,'UPDATE,REFERENCES'))
    AND NOT EXISTS(SELECT 1 FROM realms c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) g
      WHERE g.grantee<>c.relowner AND(g.grantee=0 OR g.is_grantable OR g.privilege_type NOT IN('SELECT','INSERT')))
    AND NOT EXISTS(SELECT 1 FROM realms c JOIN pg_catalog.pg_attribute col ON col.attrelid=c.oid WHERE col.attacl IS NOT NULL)
    AND (SELECT p.proowner=(SELECT relowner FROM realms LIMIT 1) AND NOT p.prosecdef
      AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) g WHERE g.grantee<>p.proowner)
      FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.protect_cashier_ordinary_v1()')) AS ready`);
  return { ready: rights?.ready === true, reason: rights?.ready === true ? '' : 'cashier_ordinary_runtime_authority_unreviewed', catalog };
}
export async function assertCashierOrdinaryReady(db: Pick<DbClient, 'execute'>) {
  if (!(await cashierOrdinaryReadiness(db)).ready) throw new HttpApiException('普通商品收银来源及实际权限尚未验收', 503, 503);
}
export async function runCashierOrdinary(db: Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Ordinary cashier commissioning requires root maintenance client');
  await db.transaction(tx => tx.execute(sql.raw(CASHIER_ORDINARY_INSTALLATION_SQL)), { isolationLevel: 'read committed', accessMode: 'read write' });
}
