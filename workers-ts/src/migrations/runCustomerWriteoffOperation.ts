import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { HttpApiException } from '@/utils/errors';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { customerWorkCatalogSql } from './customerWorkCatalog';
import { CUSTOMER_WRITEOFF_OPERATION_INSTALLATION_SQL } from './customerWriteoffOperation';
import { customerWorkScopeLockReadiness } from './runCustomerWorkScopeLock';

/** Every column, constraint, index and validator body, including all overloads. */
export const CUSTOMER_WRITEOFF_OPERATION_CATALOG_SQL = `SELECT jsonb_build_object(
 'ledger',(${customerWorkCatalogSql('customer_writeoff_operation_request').replace(' AS shape FROM', ' FROM')}),
 'policy_count',(SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid=to_regclass('public.customer_writeoff_operation_request')),
 'inbound_foreign_key_count',(SELECT count(*) FROM pg_catalog.pg_constraint WHERE confrelid=to_regclass('public.customer_writeoff_operation_request')),
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
 WHERE n.nspname='public' AND p.proname IN('customer_writeoff_intent_valid_v1','customer_writeoff_evidence_valid_v1'))
 ) AS shape,pg_catalog.current_setting('server_version_num')::integer AS server_version_num
 WHERE to_regclass('public.customer_writeoff_operation_request') IS NOT NULL`;

/** Commission only from a genuine PG16 canonical measurement. */
export const CUSTOMER_WRITEOFF_OPERATION_CATALOG_SHA256 = '8739570c3ee5b16b201150fc89d117fb0b9c8632ef1162230d4b40f749715238';
type Query = Pick<DbClient, 'execute'>;

export async function inspectCustomerWriteoffOperation(db: Query) {
  const rows = await db.execute<{ shape: unknown; server_version_num: number }>(sql.raw(CUSTOMER_WRITEOFF_OPERATION_CATALOG_SQL));
  if (rows.length === 0) return { present: false, complete: false, fingerprint: null };
  if (rows.length !== 1) throw Error('Customer writeoff operation catalog ambiguous');
  const fingerprint = await outRequestHash(rows[0].shape);
  return { present: true, complete: Math.floor(rows[0].server_version_num / 10000) === 16
    && fingerprint === CUSTOMER_WRITEOFF_OPERATION_CATALOG_SHA256, fingerprint };
}

export async function assertCustomerWriteoffOperationCatalog(db: Query) {
  if (!(await inspectCustomerWriteoffOperation(db)).complete)
    throw new HttpApiException('核销请求台账尚未安装或结构未验收，请保留原请求核对', 503, 503);
}

/** Read-only catalog and authority check, including every SET ROLE ancestor. */
export async function customerWriteoffOperationReadiness(db: Query) {
  const catalog = await inspectCustomerWriteoffOperation(db);
  if (!catalog.complete) return { ready: false, available: false,
    reason: catalog.present ? 'customer_writeoff_operation_catalog_incompatible' : 'customer_writeoff_operation_not_installed', catalog, privileges: null };
  const scope = await customerWorkScopeLockReadiness(db);
  if (!scope.ready) return { ready: false, available: false, reason: scope.reason, catalog, privileges: null };
  const rows = await db.execute<{ read: boolean; append: boolean; mutable: boolean; append_only_acl: boolean; validator_safe: boolean; authority_safe: boolean }>(sql`
 WITH RECURSIVE identity AS(SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN(current_user,session_user)
 UNION SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()),
 authority(oid) AS(SELECT oid FROM identity UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN authority a ON a.oid=m.member)
 SELECT pg_catalog.has_table_privilege(current_user,'public.customer_writeoff_operation_request','SELECT') AS read,
 pg_catalog.has_table_privilege(current_user,'public.customer_writeoff_operation_request','INSERT') AS append,
 (pg_catalog.has_table_privilege(current_user,'public.customer_writeoff_operation_request','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
 OR pg_catalog.has_any_column_privilege(current_user,'public.customer_writeoff_operation_request','UPDATE,REFERENCES')) AS mutable,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
 WHERE c.oid='public.customer_writeoff_operation_request'::regclass AND a.grantee<>c.relowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN('SELECT','INSERT')))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.customer_writeoff_operation_request'::regclass AND a.attacl IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.confrelid='public.customer_writeoff_operation_request'::regclass) AS append_only_acl,
 (SELECT count(*)=2 AND bool_and(p.proowner=c.relowner AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE') AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type<>'EXECUTE')))
 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_class c ON c.oid='public.customer_writeoff_operation_request'::regclass
 WHERE p.oid IN('public.customer_writeoff_intent_valid_v1(text,jsonb)'::regprocedure,'public.customer_writeoff_evidence_valid_v1(text,text,jsonb,jsonb)'::regprocedure)) AS validator_safe,
 NOT EXISTS(SELECT 1 FROM authority a JOIN pg_catalog.pg_class c ON c.oid='public.customer_writeoff_operation_request'::regclass
 WHERE c.relowner=a.oid OR pg_catalog.has_table_privilege(a.oid,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
 OR pg_catalog.has_any_column_privilege(a.oid,c.oid,'UPDATE,REFERENCES')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid IN('public.customer_writeoff_intent_valid_v1(text,jsonb)'::regprocedure,'public.customer_writeoff_evidence_valid_v1(text,text,jsonb,jsonb)'::regprocedure) AND p.proowner=a.oid)) AS authority_safe`);
  const p = rows[0], available = rows.length === 1 && p?.read === true && p.append === true && p.mutable === false
    && p.append_only_acl === true && p.validator_safe === true && p.authority_safe === true;
  return { ready: available, available, reason: available ? '' : 'customer_writeoff_operation_runtime_privileges_unreviewed', catalog, privileges: p ?? null };
}

export async function runCustomerWriteoffOperation(db: Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Customer writeoff installation requires root maintenance client');
  await db.transaction(async tx => { await tx.execute(sql.raw(CUSTOMER_WRITEOFF_OPERATION_INSTALLATION_SQL)); },
    { isolationLevel: 'read committed', accessMode: 'read write' });
}
