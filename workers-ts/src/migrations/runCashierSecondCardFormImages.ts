import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { HttpApiException } from '@/utils/errors';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { customerWorkCatalogSql } from './customerWorkCatalog';
import { cashierSecondCardOriginReadiness } from './runCashierSecondCardOrigin';
import { CASHIER_SECOND_CARD_FORM_IMAGES_INSTALLATION_SQL, CASHIER_SECOND_CARD_FORM_IMAGE_TABLES,
  CASHIER_SECOND_CARD_FORM_IMAGE_FUNCTIONS, CASHIER_SECOND_CARD_FORM_SESSION_UPDATE_COLUMNS,
  CASHIER_SECOND_CARD_FORM_UPLOAD_UPDATE_COLUMNS } from './cashierSecondCardFormImages';
const functionNames = CASHIER_SECOND_CARD_FORM_IMAGE_FUNCTIONS.map(fn => fn.slice(0, fn.indexOf('(')));
const tableNames = CASHIER_SECOND_CARD_FORM_IMAGE_TABLES.map(table => `'${table}'`).join(',');
const routineNames = functionNames.map(name => `'${name}'`).join(',');
const tableRefs = CASHIER_SECOND_CARD_FORM_IMAGE_TABLES.map(table => `to_regclass('public.${table}')`).join(',');
export const CASHIER_SECOND_CARD_FORM_IMAGES_CATALOG_SQL = `SELECT jsonb_build_object(
 'tables',jsonb_build_object(${CASHIER_SECOND_CARD_FORM_IMAGE_TABLES.map(table => `'${table}',(${customerWorkCatalogSql(table).replace(' AS shape FROM', ' FROM')})`).join(',')}),
 'dropped_columns',(SELECT count(*) FROM pg_catalog.pg_attribute WHERE attrelid IN(${tableRefs}) AND attnum>0 AND attisdropped),
 'policy_count',(SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid IN(${tableRefs})),
 'inbound_foreign_keys',(SELECT jsonb_agg(jsonb_build_object('table',k.conrelid::regclass::text,'name',k.conname,'definition',pg_catalog.pg_get_constraintdef(k.oid)) ORDER BY k.conname)
 FROM pg_catalog.pg_constraint k WHERE k.confrelid IN(${tableRefs})),
 'routines',(SELECT jsonb_agg(jsonb_build_object(
 'name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),'result',pg_get_function_result(p.oid),
 'kind',p.prokind,'language',l.lanname,'trusted',l.lanpltrusted,'security_definer',p.prosecdef,
 'volatile',p.provolatile,'parallel',p.proparallel,'leakproof',p.proleakproof,'strict',p.proisstrict,
 'set_result',p.proretset,'source',p.prosrc,'config',p.proconfig,'support',p.prosupport::text,
 'binary',p.probin,'sql_body',p.prosqlbody::text,'cost',p.procost,'rows',p.prorows,
 'variadic',p.provariadic::text,'default_count',p.pronargdefaults,'all_argument_types',p.proallargtypes::text,
 'argument_modes',p.proargmodes,'argument_names',p.proargnames,'defaults',p.proargdefaults::text,'transform_types',p.protrftypes::text
 ) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_catalog.pg_proc p
 JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang
 WHERE n.nspname='public' AND p.proname IN(${routineNames})),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('table',t.tgrelid::regclass::text,'name',CASE WHEN t.tgisinternal THEN NULL ELSE t.tgname END,'type',t.tgtype,
 'enabled',t.tgenabled,'internal',t.tgisinternal,'argument_count',t.tgnargs,'arguments',pg_catalog.encode(t.tgargs,'hex'),
 'columns',t.tgattr::text,'condition',pg_catalog.pg_get_expr(t.tgqual,t.tgrelid),'deferrable',t.tgdeferrable,
 'initially_deferred',t.tginitdeferred,'constraint',k.conname,'old_table',t.tgoldtable,'new_table',t.tgnewtable,
 'has_parent',t.tgparentid<>0,'routine',n.nspname||'.'||p.proname,'routine_arguments',pg_catalog.pg_get_function_identity_arguments(p.oid))
 ORDER BY t.tgrelid::regclass::text,p.proname,t.tgtype,k.conname,t.tgisinternal,CASE WHEN t.tgisinternal THEN '' ELSE t.tgname END)
 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
 JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace LEFT JOIN pg_catalog.pg_constraint k ON k.oid=t.tgconstraint
 WHERE t.tgrelid IN(${tableRefs}) OR (n.nspname='public' AND p.proname IN(${routineNames})))
 ) AS shape,pg_catalog.current_setting('server_version_num')::integer AS server_version_num
 WHERE EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN(${tableNames}))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN(${routineNames}))`;
/** Derived from a newly owned portable PG16 cluster, never from runtime state. */
export const CASHIER_SECOND_CARD_FORM_IMAGES_CATALOG_SHA256 = '434908c11ec8e19c848e3558aca2cb78641ab86dff82bd0fa0e68265d69eda5d';
type Query = Pick<DbClient, 'execute'>;
export async function inspectCashierSecondCardFormImages(db: Query) {
  const rows = await db.execute<{ shape: unknown; server_version_num: number }>(sql.raw(CASHIER_SECOND_CARD_FORM_IMAGES_CATALOG_SQL));
  if (!rows.length) return { present: false, complete: false, fingerprint: null };
  if (rows.length !== 1) throw Error('Cashier form image catalog is ambiguous');
  const fingerprint = await outRequestHash(rows[0].shape);
  return { present: true, complete: Math.floor(rows[0].server_version_num / 10000) === 16
    && fingerprint === CASHIER_SECOND_CARD_FORM_IMAGES_CATALOG_SHA256, fingerprint };
}
export async function assertCashierSecondCardFormImagesCatalog(db: Query) {
  if (!(await inspectCashierSecondCardFormImages(db)).complete)
    throw new HttpApiException('收银表单图片台账尚未安装或结构未验收，请保留原上传请求核对', 503, 503);
}
const allowedColumns = [
  ...CASHIER_SECOND_CARD_FORM_SESSION_UPDATE_COLUMNS.map(column => `('cashier_second_card_form_session_v1','${column}')`),
  ...CASHIER_SECOND_CARD_FORM_UPLOAD_UPDATE_COLUMNS.map(column => `('cashier_second_card_form_upload_v1','${column}')`),
].join(',');
export const CASHIER_SECOND_CARD_FORM_IMAGES_PRIVILEGES_SQL = `WITH RECURSIVE
 identity AS(SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN(current_user,session_user)
 UNION SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()),
 authority(oid) AS(SELECT oid FROM identity UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN authority a ON a.oid=m.member),
 relations AS(SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN(${tableNames})),
 routines AS(SELECT p.* FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN(${routineNames})),
 columns AS(SELECT a.*,c.relname FROM relations c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 allowed_columns(table_name,column_name) AS(VALUES ${allowedColumns}),
 shared_sequences AS(SELECT pg_catalog.pg_get_serial_sequence('public.system_attachment','att_id')::regclass AS attachment,
 pg_catalog.pg_get_serial_sequence('public.system_form_data','id')::regclass AS collection)
 SELECT (SELECT count(*)=2 AND bool_and(pg_catalog.has_table_privilege(current_user,oid,'SELECT')
 AND pg_catalog.has_table_privilege(current_user,oid,'INSERT')) FROM relations) AS read_append,
 NOT EXISTS(SELECT 1 FROM relations c WHERE pg_catalog.has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
 OR pg_catalog.has_any_column_privilege(current_user,c.oid,'REFERENCES'))
 AND NOT EXISTS(SELECT 1 FROM columns c WHERE NOT EXISTS(SELECT 1 FROM allowed_columns a WHERE a.table_name=c.relname AND a.column_name=c.attname)
 AND pg_catalog.has_column_privilege(current_user,c.attrelid,c.attnum,'UPDATE')) AS narrow_update,
 NOT EXISTS(SELECT 1 FROM allowed_columns a LEFT JOIN columns c ON c.relname=a.table_name AND c.attname=a.column_name
 WHERE c.attnum IS NULL OR NOT pg_catalog.has_column_privilege(current_user,c.attrelid,c.attnum,'UPDATE')) AS required_update,
 NOT EXISTS(SELECT 1 FROM relations c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) g
 WHERE g.grantee<>c.relowner AND(g.grantee=0 OR g.is_grantable OR g.privilege_type NOT IN('SELECT','INSERT')))
 AND NOT EXISTS(SELECT 1 FROM columns c CROSS JOIN LATERAL pg_catalog.aclexplode(c.attacl) g WHERE g.is_grantable OR g.grantee=0
 OR g.privilege_type<>'UPDATE' OR NOT EXISTS(SELECT 1 FROM allowed_columns a WHERE a.table_name=c.relname AND a.column_name=c.attname)) AS acl_safe,
 (SELECT count(*)=3 AND bool_and(pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')
 AND p.proowner=(SELECT relowner FROM relations WHERE relname='cashier_second_card_form_session_v1')
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) g
 WHERE g.grantee<>p.proowner AND(g.grantee=0 OR g.is_grantable OR g.privilege_type<>'EXECUTE'))) FROM routines p)
 AND (SELECT count(DISTINCT relowner)=1 FROM relations) AS routines_safe,
 NOT EXISTS(SELECT 1 FROM authority a JOIN relations c ON c.relowner=a.oid
 OR pg_catalog.has_table_privilege(a.oid,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_any_column_privilege(a.oid,c.oid,'REFERENCES')
 OR EXISTS(SELECT 1 FROM columns col WHERE col.attrelid=c.oid AND NOT EXISTS(SELECT 1 FROM allowed_columns permitted
 WHERE permitted.table_name=col.relname AND permitted.column_name=col.attname) AND pg_catalog.has_column_privilege(a.oid,c.oid,col.attnum,'UPDATE')))
 AND NOT EXISTS(SELECT 1 FROM authority a JOIN routines p ON p.proowner=a.oid) AS authority_safe,
 current_user=session_user AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity b JOIN pg_catalog.pg_roles r ON r.oid=b.usesysid
 WHERE b.pid=pg_catalog.pg_backend_pid() AND r.rolname=session_user AND r.rolcanlogin)
 AND NOT EXISTS(SELECT 1 FROM authority a JOIN pg_catalog.pg_roles r ON r.oid=a.oid WHERE r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
 OR r.rolreplication OR r.rolbypassrls OR pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET')
 OR pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='public' AND(n.nspowner=r.oid OR pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE')))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_database d WHERE d.datname=current_database() AND d.datdba=r.oid)) AS role_safe,
 pg_catalog.has_table_privilege(current_user,'public.system_attachment','SELECT')
 AND pg_catalog.has_table_privilege(current_user,'public.system_attachment','INSERT')
 AND pg_catalog.has_column_privilege(current_user,'public.system_attachment','att_dir','UPDATE')
 AND pg_catalog.has_column_privilege(current_user,'public.system_attachment','satt_dir','UPDATE')
 AND pg_catalog.has_column_privilege(current_user,'public.system_attachment','att_id','UPDATE')
 AND pg_catalog.has_table_privilege(current_user,'public.system_form','SELECT')
 AND pg_catalog.has_column_privilege(current_user,'public.system_form','id','UPDATE')
 AND pg_catalog.has_table_privilege(current_user,'public.system_form_data','SELECT')
 AND pg_catalog.has_table_privilege(current_user,'public.system_form_data','INSERT')
 AND (SELECT attachment IS NOT NULL AND collection IS NOT NULL AND pg_catalog.has_sequence_privilege(current_user,attachment,'USAGE')
 AND pg_catalog.has_sequence_privilege(current_user,collection,'USAGE') FROM shared_sequences) AS shared_writes`;
export async function cashierSecondCardFormImagesReadiness(db: Query) {
  const catalog = await inspectCashierSecondCardFormImages(db);
  if (!catalog.complete) return { ready: false, available: false, reason: catalog.present
    ? 'cashier_second_card_form_images_catalog_incompatible' : 'cashier_second_card_form_images_not_installed', catalog, privileges: null };
  const origin = await cashierSecondCardOriginReadiness(db);
  if (!origin.ready) return { ready: false, available: false, reason: origin.reason, catalog, privileges: null, origin };
  // Missing consumer tables must fail closed, without undefined-regclass errors.
  const [shared] = await db.execute<{ present: boolean }>(sql`SELECT to_regclass('public.system_attachment') IS NOT NULL
    AND to_regclass('public.system_form') IS NOT NULL AND to_regclass('public.system_form_data') IS NOT NULL AS present`);
  if (shared?.present !== true) return { ready: false, available: false, reason: 'cashier_second_card_form_consumers_missing', catalog, privileges: null, origin };
  const rows = await db.execute<Record<string, boolean>>(sql.raw(CASHIER_SECOND_CARD_FORM_IMAGES_PRIVILEGES_SQL));
  const privileges = rows[0], available = rows.length === 1 && ['read_append','narrow_update','required_update','acl_safe','routines_safe','authority_safe','role_safe','shared_writes']
    .every(name => privileges?.[name] === true);
  return { ready: available, available, reason: available ? '' : 'cashier_second_card_form_images_runtime_privileges_unreviewed', catalog, privileges: privileges ?? null, origin };
}
/** Explicit owner connection only. An API readiness check never invokes this. */
export async function runCashierSecondCardFormImages(db: Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Cashier form image installation requires root maintenance client');
  await db.transaction(async tx => { await tx.execute(sql.raw(CASHIER_SECOND_CARD_FORM_IMAGES_INSTALLATION_SQL)); },
    { isolationLevel: 'read committed', accessMode: 'read write' });
}
