import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { HttpApiException } from '@/utils/errors';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { customerWorkCatalogSql } from './customerWorkCatalog';
import { CASHIER_SECOND_CARD_ORIGIN_INSTALLATION_SQL } from './cashierSecondCardOrigin';
import { CASHIER_SECOND_CARD_TABLES } from './cashierSecondCardRuntimePlan';
import { customerWorkScopeLockReadiness } from './runCustomerWorkScopeLock';
import { cashierSecondCardPromotionLockReadiness } from './cashierSecondCardPromotionLock';

export const CASHIER_SECOND_CARD_ORIGIN_CATALOG_SQL = `SELECT jsonb_build_object(
 'tables',jsonb_build_object(${CASHIER_SECOND_CARD_TABLES.map(table => `'${table}',(${customerWorkCatalogSql(table).replace(' AS shape FROM', ' FROM')})`).join(',')}),
 'policy_count',(SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid IN(${CASHIER_SECOND_CARD_TABLES.map(table => `to_regclass('public.${table}')`).join(',')})),
 'inbound_foreign_key_count',(SELECT count(*) FROM pg_catalog.pg_constraint WHERE confrelid IN(${CASHIER_SECOND_CARD_TABLES.map(table => `to_regclass('public.${table}')`).join(',')})),
 'validators',(SELECT jsonb_agg(jsonb_build_object(
 'name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),'result',pg_get_function_result(p.oid),
 'kind',p.prokind,'language',l.lanname,'trusted',l.lanpltrusted,'security_definer',p.prosecdef,
 'volatile',p.provolatile,'parallel',p.proparallel,'leakproof',p.proleakproof,'strict',p.proisstrict,
 'set_result',p.proretset,'source',p.prosrc,'config',p.proconfig,'support',p.prosupport::text,
 'binary',p.probin,'sql_body',p.prosqlbody::text,'cost',p.procost,'rows',p.prorows,
 'variadic',p.provariadic::text,'default_count',p.pronargdefaults,'all_argument_types',p.proallargtypes::text,
 'argument_modes',p.proargmodes,'argument_names',p.proargnames,'defaults',p.proargdefaults::text,'transform_types',p.protrftypes::text
 ) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid))
 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang
 WHERE n.nspname='public' AND p.proname IN('cashier_second_card_origin_valid_v1','cashier_second_card_payment_valid_v1'))
 ) AS shape,pg_catalog.current_setting('server_version_num')::integer AS server_version_num
 WHERE EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN('cashier_second_card_cart_v1','cashier_second_card_origin_v1','cashier_second_card_payment_v1'))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN('cashier_second_card_origin_valid_v1','cashier_second_card_payment_valid_v1'))`;
export const CASHIER_SECOND_CARD_ORIGIN_CATALOG_SHA256 = '57384854d017b6c44e498097e4ca96cf34bd63b96cbc38d4fe7e9d6d315b5823';
type Query = Pick<DbClient, 'execute'>;
export async function inspectCashierSecondCardOrigin(db: Query) {
  const rows = await db.execute<{ shape: unknown; server_version_num: number }>(sql.raw(CASHIER_SECOND_CARD_ORIGIN_CATALOG_SQL));
  if (rows.length === 0) return { present: false, complete: false, fingerprint: null };
  if (rows.length !== 1) throw Error('Cashier second card origin catalog ambiguous');
  const fingerprint = await outRequestHash(rows[0].shape);
  return { present: true, complete: Math.floor(rows[0].server_version_num / 10000) === 16
    && fingerprint === CASHIER_SECOND_CARD_ORIGIN_CATALOG_SHA256, fingerprint };
}
export async function assertCashierSecondCardOriginCatalog(db: Query) {
  if (!(await inspectCashierSecondCardOrigin(db)).complete)
    throw new HttpApiException('收银次卡来源台账尚未安装或结构未验收，请保留原请求核对', 503, 503);
}
/** All three realms are append-only and have no latent owner/mutation authority. */
export async function cashierSecondCardOriginReadiness(db: Query) {
  const catalog = await inspectCashierSecondCardOrigin(db);
  if (!catalog.complete) return { ready: false, available: false, reason: catalog.present ? 'cashier_second_card_origin_catalog_incompatible' : 'cashier_second_card_origin_not_installed', catalog, privileges: null };
  const scope = await customerWorkScopeLockReadiness(db);
  if (!scope.ready) return { ready: false, available: false, reason: scope.reason, catalog, privileges: null };
  const promotionGuard = await cashierSecondCardPromotionLockReadiness(db);
  if (!promotionGuard.ready) return { ready: false, available: false, reason: promotionGuard.reason, catalog, privileges: null, promotionGuard };
  const rows = await db.execute<{ read: boolean; append: boolean; mutable: boolean; append_only_acl: boolean; validator_safe: boolean; authority_safe: boolean;
    promotion_read: boolean; promotion_append: boolean; promotion_sequence_usage: boolean; promotion_lock_update: boolean; promotion_safe: boolean }>(sql`
 WITH RECURSIVE identity AS(SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN(current_user,session_user)
 UNION SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()),
 authority(oid) AS(SELECT oid FROM identity UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN authority a ON a.oid=m.member),
 relations AS(SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN('cashier_second_card_cart_v1','cashier_second_card_origin_v1','cashier_second_card_payment_v1')),
 validators AS(SELECT p.* FROM pg_catalog.pg_proc p WHERE p.oid IN('public.cashier_second_card_origin_valid_v1(text,jsonb)'::regprocedure,'public.cashier_second_card_payment_valid_v1(text,jsonb)'::regprocedure)),
 promotion AS(SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname='store_order_promotions' AND c.relkind='r'),
 promotion_sequences AS(SELECT s.* FROM promotion c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname='id' AND NOT a.attisdropped
 JOIN pg_catalog.pg_depend d ON d.refclassid='pg_catalog.pg_class'::regclass AND d.refobjid=c.oid AND d.refobjsubid=a.attnum
 AND d.classid='pg_catalog.pg_class'::regclass AND d.deptype IN('a','i')
 JOIN pg_catalog.pg_class s ON s.oid=d.objid AND s.relkind='S'
 JOIN pg_catalog.pg_namespace n ON n.oid=s.relnamespace AND n.nspname='public'
 WHERE s.oid=pg_catalog.pg_get_serial_sequence(pg_catalog.format('%I.%I','public',c.relname),a.attname)::regclass)
 SELECT (SELECT count(*)=3 AND bool_and(pg_catalog.has_table_privilege(current_user,oid,'SELECT')) FROM relations) AS read,
 (SELECT count(*)=3 AND bool_and(pg_catalog.has_table_privilege(current_user,oid,'INSERT')) FROM relations) AS append,
 EXISTS(SELECT 1 FROM relations WHERE pg_catalog.has_table_privilege(current_user,oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_any_column_privilege(current_user,oid,'UPDATE,REFERENCES')) AS mutable,
 NOT EXISTS(SELECT 1 FROM relations c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
 WHERE a.grantee<>c.relowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN('SELECT','INSERT')))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a JOIN relations c ON c.oid=a.attrelid WHERE a.attacl IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k JOIN relations c ON c.oid=k.confrelid) AS append_only_acl,
 (SELECT count(*)=2 AND bool_and(p.proowner=(SELECT relowner FROM relations WHERE relname='cashier_second_card_origin_v1')
 AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
 WHERE a.grantee<>p.proowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type<>'EXECUTE'))) FROM validators p)
 AND (SELECT count(DISTINCT relowner)=1 FROM relations) AS validator_safe,
 NOT EXISTS(SELECT 1 FROM authority a JOIN relations c ON c.relowner=a.oid
 OR pg_catalog.has_table_privilege(a.oid,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_any_column_privilege(a.oid,c.oid,'UPDATE,REFERENCES'))
 AND NOT EXISTS(SELECT 1 FROM authority a JOIN validators p ON p.proowner=a.oid) AS authority_safe,
 (SELECT count(*)=1 AND bool_and(pg_catalog.has_table_privilege(current_user,oid,'SELECT')) FROM promotion) AS promotion_read,
 (SELECT count(*)=1 AND bool_and(pg_catalog.has_table_privilege(current_user,oid,'INSERT')) FROM promotion) AS promotion_append,
 (SELECT count(*)=1 AND bool_and(pg_catalog.has_column_privilege(current_user,oid,'id','UPDATE')) FROM promotion) AS promotion_lock_update,
 (SELECT count(*)=1 AND bool_and(pg_catalog.has_sequence_privilege(current_user,oid,'USAGE')) FROM promotion_sequences) AS promotion_sequence_usage,
 NOT EXISTS(SELECT 1 FROM authority a JOIN promotion c ON c.relowner=a.oid
 OR pg_catalog.has_table_privilege(a.oid,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
 OR pg_catalog.has_any_column_privilege(a.oid,c.oid,'REFERENCES')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col WHERE col.attrelid=c.oid AND col.attnum>0 AND NOT col.attisdropped
 AND col.attname<>'id' AND pg_catalog.has_column_privilege(a.oid,c.oid,col.attnum,'UPDATE')))
 AND NOT EXISTS(SELECT 1 FROM promotion c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) g
 WHERE (g.grantee=0 AND g.privilege_type<>'SELECT') OR (g.is_grantable AND g.grantee IN(SELECT oid FROM authority)))
 AND NOT EXISTS(SELECT 1 FROM authority a JOIN promotion_sequences s ON s.relowner=a.oid OR pg_catalog.has_sequence_privilege(a.oid,s.oid,'UPDATE'))
 AND NOT EXISTS(SELECT 1 FROM promotion_sequences s CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(s.relacl,pg_catalog.acldefault('s',s.relowner))) g
 WHERE g.grantee=0 OR (g.is_grantable AND g.grantee IN(SELECT oid FROM authority))) AS promotion_safe`);
  const p = rows[0], available = rows.length === 1 && p?.read === true && p.append === true && p.mutable === false
    && p.append_only_acl === true && p.validator_safe === true && p.authority_safe === true
    && p.promotion_read === true && p.promotion_append === true && p.promotion_lock_update === true
    && p.promotion_sequence_usage === true && p.promotion_safe === true;
  return { ready: available, available, reason: available ? '' : 'cashier_second_card_runtime_privileges_unreviewed', catalog, privileges: p ?? null, promotionGuard };
}
export async function runCashierSecondCardOrigin(db: Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Cashier second card installation requires root maintenance client');
  await db.transaction(async tx => { await tx.execute(sql.raw(CASHIER_SECOND_CARD_ORIGIN_INSTALLATION_SQL)); },
    { isolationLevel: 'read committed', accessMode: 'read write' });
}
