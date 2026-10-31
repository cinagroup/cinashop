import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectAdminWechatRoutineOperation } from './adminWechatRoutineOperation';
import { ADMIN_WECHAT_ROUTINE_STORED_TEXT_FUNCTION, ADMIN_WECHAT_ROUTINE_STORED_TEXT_SIGNATURE,
  ADMIN_WECHAT_ROUTINE_STORED_TEXT_BODY } from './adminWechatRoutineStoredText';
import { ADMIN_WECHAT_ROUTINE_WRITE_FUNCTION, ADMIN_WECHAT_ROUTINE_WRITE_SIGNATURE,
  ADMIN_WECHAT_ROUTINE_CONFIG_GUARD_FUNCTION, ADMIN_WECHAT_ROUTINE_CONFIG_GUARD_SIGNATURE,
  adminWechatRoutineWriteBody, adminWechatRoutineConfigGuardBody,
  type AdminWechatRoutineWriteBinding } from './adminWechatRoutineWriteCapability';

type Query = Pick<DbClient, 'execute'>;
type Names = { maintenance: string; admin: string; writer: string };
export interface AdminWechatRoutineWriteCatalog {
  present: boolean; ready: boolean; binding: AdminWechatRoutineWriteBinding | null; failures: string[];
}
type FunctionRow = Record<string, unknown> & { oid: string; name: string; owner: string; owner_oid: number;
  body: string; arguments: string; argument_names: string[] | null; returns: number;
  config: string[] | null; definer: boolean; strict: boolean; volatility: string; flags: boolean;
  acl: Array<[string, string, boolean, string]> };
const sorted = (rows: Array<Array<string | boolean>>) => [...rows].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const columns = [
  ['id', 'integer', 'serial'], ['is_store', 'smallint', '0'], ['menu_name', 'character varying(255)', "''::character varying"],
  ['type', 'character varying(255)', "''::character varying"], ['input_type', 'character varying(20)', "'input'::character varying"],
  ['config_tab_id', 'integer', '0'], ['parameter', 'character varying(255)', "''::character varying"],
  ['upload_type', 'smallint', '1'], ['required', 'character varying(255)', "''::character varying"],
  ['width', 'integer', '0'], ['high', 'integer', '0'], ['value', 'character varying(5000)', "''::character varying"],
  ['info', 'character varying(255)', "''::character varying"], ['desc', 'character varying(255)', "''::character varying"],
  ['sort', 'integer', '0'], ['status', 'smallint', '0'],
];
const indexes = [
  ['config_tab_id', '6', '0', false, false],
  ['system_config_is_store_idx', '2', '0', false, false],
  ['system_config_lookup', '2 3 15 1', '0 0 3 3', false, false],
  ['system_config_menu_name_idx', '3', '0', false, false],
  ['system_config_pkey', '1', '0', true, true],
];

/** Read-only inspection, never a grant/repair or proof of a current HTTP actor.
 * Inferred names still have to reproduce the entire OID-bound function bodies;
 * a renamed identity or a replacement role/database cannot reuse old SQL. */
export async function inspectAdminWechatRoutineWriteCatalog(tx: Query, names?: Names): Promise<AdminWechatRoutineWriteCatalog> {
  const failures: string[] = [];
  const check = (name: string, ok: boolean) => { if (!ok) failures.push(name); };
  const [context] = await tx.execute<{ database: string; database_oid: number; maintenance: string | null; present: boolean }>(sql`SELECT
    current_database() AS database,(SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=current_database()) AS database_oid,
    (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid=to_regclass('public.admin_wechat_routine_operation')) AS maintenance,
    EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
      AND (starts_with(relname,'admin_wechat_routine_operation') OR starts_with(relname,'awro_')))
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
        AND (starts_with(proname,'cinashop_admin_wechat_routine_') OR starts_with(proname,'cinashop_wechat_routine_')
          OR starts_with(proname,'admin_wechat_routine_')))
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE starts_with(tgname,'routine_config_') OR starts_with(tgname,'awro_')) AS present`);
  if (!context.present) return { present: false, ready: false, binding: null, failures: [] };
  const [namespace] = await tx.execute<{ safe: boolean }>(sql`SELECT
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
      AND (starts_with(relname,'admin_wechat_routine_operation') OR starts_with(relname,'awro_'))
      AND relname NOT IN('admin_wechat_routine_operation','awro_pk'))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
      AND (starts_with(proname,'cinashop_admin_wechat_routine_') OR starts_with(proname,'cinashop_wechat_routine_')
        OR starts_with(proname,'admin_wechat_routine_'))
      AND proname NOT IN(${ADMIN_WECHAT_ROUTINE_WRITE_FUNCTION},${ADMIN_WECHAT_ROUTINE_CONFIG_GUARD_FUNCTION},
        ${ADMIN_WECHAT_ROUTINE_STORED_TEXT_FUNCTION},'admin_wechat_routine_operation_immutable_v1'))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE (starts_with(tgname,'routine_config_') OR starts_with(tgname,'awro_'))
      AND NOT(tgname IN('routine_config_rows','routine_config_truncate') AND tgrelid=to_regclass('public.system_config')
        OR tgname IN('awro_immutable_rows','awro_immutable_truncate') AND tgrelid=to_regclass('public.admin_wechat_routine_operation'))) AS safe`);
  check('namespace', namespace?.safe === true);
  const functions = await tx.execute<FunctionRow>(sql`SELECT p.oid::text AS oid,p.proname AS name,
    pg_catalog.pg_get_userbyid(p.proowner) AS owner,p.proowner::bigint AS owner_oid,p.prosrc AS body,
    p.proargtypes::text AS arguments,p.proargnames AS argument_names,p.prorettype::integer AS returns,
    p.proconfig AS config,p.prosecdef AS definer,p.proisstrict AS strict,p.provolatile::text AS volatility,
    p.prokind='f' AND p.proparallel='u' AND NOT p.proleakproof AND NOT p.proretset AND p.provariadic=0
      AND p.pronargdefaults=0 AND p.proargdefaults IS NULL AND p.prosupport=0 AND p.probin IS NULL AND p.prosqlbody IS NULL
      AND p.proallargtypes IS NULL AND p.proargmodes IS NULL AND p.protrftypes IS NULL AND p.procost=100 AND p.prorows=0
      AND p.pronargs=pg_catalog.cardinality(p.proargtypes::oid[])
      AND l.lanname='plpgsql' AND l.lanpltrusted AS flags,
    (SELECT COALESCE(jsonb_agg(jsonb_build_array(pg_catalog.pg_get_userbyid(a.grantee),a.privilege_type,
      a.is_grantable,pg_catalog.pg_get_userbyid(a.grantor))),'[]'::jsonb)
      FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a) AS acl
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE p.pronamespace='public'::regnamespace AND p.proname IN (${ADMIN_WECHAT_ROUTINE_WRITE_FUNCTION},
      ${ADMIN_WECHAT_ROUTINE_CONFIG_GUARD_FUNCTION},${ADMIN_WECHAT_ROUTINE_STORED_TEXT_FUNCTION})`);
  const main = functions.find(row => row.name === ADMIN_WECHAT_ROUTINE_WRITE_FUNCTION);
  const external = main?.acl.filter(row => row[0] !== main.owner && row[1] === 'EXECUTE') ?? [];
  const inferred: Names | null = context.maintenance && main && external.length === 1
    ? { maintenance: context.maintenance, admin: external[0][0], writer: main.owner } : null;
  const target = names ?? inferred;
  if (!target) return { present: true, ready: false, binding: null, failures: ['binding'] };
  try { [target.maintenance, target.admin, target.writer, context.database].forEach(pricingIdentifier); }
  catch { return { present: true, ready: false, binding: null, failures: ['binding'] }; }
  check('identities', new Set(Object.values(target)).size === 3 && inferred !== null
    && target.maintenance === inferred.maintenance && target.admin === inferred.admin && target.writer === inferred.writer);
  const roles = await tx.execute<{ name: string; oid: number }>(sql`SELECT rolname AS name,oid::bigint AS oid
    FROM pg_catalog.pg_roles WHERE rolname IN (${target.maintenance},${target.admin},${target.writer})`);
  const binding: AdminWechatRoutineWriteBinding = { database: context.database, databaseOid: Number(context.database_oid),
    admin: target.admin, adminOid: Number(roles.find(row => row.name === target.admin)?.oid),
    writer: target.writer, writerOid: Number(roles.find(row => row.name === target.writer)?.oid) };
  if (![binding.databaseOid, binding.adminOid, binding.writerOid].every(value => Number.isSafeInteger(value) && value > 0 && value <= 4294967295)) {
    return { present: true, ready: false, binding: null, failures: [...failures, 'binding_oids'] };
  }
  const expected = [
    { name: ADMIN_WECHAT_ROUTINE_STORED_TEXT_FUNCTION, signature: ADMIN_WECHAT_ROUTINE_STORED_TEXT_SIGNATURE,
      owner: target.maintenance, body: ADMIN_WECHAT_ROUTINE_STORED_TEXT_BODY, arguments: '25', names: ['p_raw'], returns: 17,
      config: ['search_path=pg_catalog'], definer: false, strict: true, volatility: 'i',
      acl: [[target.maintenance, 'EXECUTE', false, target.maintenance], [target.writer, 'EXECUTE', false, target.maintenance]] },
    { name: ADMIN_WECHAT_ROUTINE_WRITE_FUNCTION, signature: ADMIN_WECHAT_ROUTINE_WRITE_SIGNATURE,
      owner: target.writer, body: adminWechatRoutineWriteBody(binding), arguments: '2950 23 25 25 25 25 3802',
      names: ['p_id','p_actor','p_operation','p_revision','p_expected_source','p_actor_binding','p_fields'], returns: 3802,
      config: ['search_path=pg_catalog, pg_temp'], definer: true, strict: false, volatility: 'v',
      acl: [[target.writer, 'EXECUTE', false, target.writer], [target.admin, 'EXECUTE', false, target.writer]] },
    { name: ADMIN_WECHAT_ROUTINE_CONFIG_GUARD_FUNCTION, signature: ADMIN_WECHAT_ROUTINE_CONFIG_GUARD_SIGNATURE,
      owner: target.maintenance, body: adminWechatRoutineConfigGuardBody(binding), arguments: '', names: null, returns: 2279,
      config: ['search_path=pg_catalog'], definer: false, strict: false, volatility: 'v',
      acl: [[target.maintenance, 'EXECUTE', false, target.maintenance]] },
  ];
  for (const wanted of expected) {
    const matches = functions.filter(row => row.name === wanted.name), row = matches[0];
    check('function:' + wanted.name, matches.length === 1 && row.flags === true && row.owner === wanted.owner
      && row.body === wanted.body && row.arguments === wanted.arguments && row.returns === wanted.returns
      && equal(row.argument_names, wanted.names) && equal(row.config, wanted.config)
      && row.definer === wanted.definer && row.strict === wanted.strict && row.volatility === wanted.volatility);
    check('acl:' + wanted.name, !!row && equal(sorted(row.acl), sorted(wanted.acl)));
  }
  check('operation', await inspectAdminWechatRoutineOperation(tx, target));
  const mainOid = main?.oid ?? '0';
  const guardOid = functions.find(row => row.name === ADMIN_WECHAT_ROUTINE_CONFIG_GUARD_FUNCTION)?.oid ?? '0';
  const [roleChecks] = await tx.execute<Record<string, boolean>>(sql`SELECT
    (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=${target.maintenance}) AS maintenance,
    (SELECT rolcanlogin AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database d WHERE pg_catalog.has_database_privilege(r.oid,d.oid,'CREATE'))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
      AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE')
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
      FROM pg_catalog.pg_roles r WHERE rolname=${target.admin}) AS admin_role,
    (SELECT NOT(rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usesysid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
        WHERE a.grantee=r.oid OR(a.grantee=0 AND d.defaclobjtype IN('r','S')))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database d WHERE pg_catalog.has_database_privilege(r.oid,d.oid,'CREATE'))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
      AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE')
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
      AND (SELECT count(*)=1 AND bool_and(classid='pg_catalog.pg_proc'::regclass AND objid=${mainOid}::oid
        AND objsubid=0 AND dbid=${binding.databaseOid}::oid) FROM pg_catalog.pg_shdepend
        WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
      FROM pg_catalog.pg_roles r WHERE rolname=${target.writer}) AS writer_role,
    (SELECT count(*)=4 AND bool_and(a.grantee=${binding.writerOid}::oid AND NOT a.is_grantable
      AND a.privilege_type IN('SELECT','INSERT') AND pg_catalog.pg_get_userbyid(a.grantor)=${target.maintenance})
      FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE c.oid IN(to_regclass('public.system_config'),to_regclass('public.admin_wechat_routine_operation'))
        AND a.grantee=${binding.writerOid}::oid) AS writer_table_acl,
    (SELECT count(*)=1 AND bool_and(a.attrelid=to_regclass('public.system_config') AND a.attname='value'
      AND x.privilege_type='UPDATE' AND NOT x.is_grantable AND pg_catalog.pg_get_userbyid(x.grantor)=${target.maintenance})
      FROM pg_catalog.pg_attribute a CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
      WHERE x.grantee=${binding.writerOid}::oid) AS writer_column_acl,
    (SELECT count(*)=1 AND bool_and(c.oid=to_regclass('public.system_config_id_seq') AND a.privilege_type='USAGE'
      AND NOT a.is_grantable AND pg_catalog.pg_get_userbyid(a.grantor)=${target.maintenance})
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('S',c.relowner))) a
      WHERE c.relkind='S' AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
        AND a.grantee=${binding.writerOid}::oid) AS writer_sequence_acl,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN (VALUES('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege)
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN('r','p','v','m','f')
      AND (pg_catalog.has_table_privilege(${target.writer},c.oid,p.privilege) IS DISTINCT FROM
        (c.oid IN (to_regclass('public.system_config'),to_regclass('public.admin_wechat_routine_operation')) AND p.privilege IN('SELECT','INSERT'))
        OR pg_catalog.has_table_privilege(${target.writer},c.oid,p.privilege||' WITH GRANT OPTION'))) AS writer_tables,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN (VALUES('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(privilege)
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
      AND (pg_catalog.has_column_privilege(${target.writer},c.oid,a.attnum,p.privilege) IS DISTINCT FROM
        ((c.oid IN(to_regclass('public.system_config'),to_regclass('public.admin_wechat_routine_operation')) AND p.privilege IN('SELECT','INSERT'))
          OR (c.oid=to_regclass('public.system_config') AND a.attname='value' AND p.privilege='UPDATE'))
        OR pg_catalog.has_column_privilege(${target.writer},c.oid,a.attnum,p.privilege||' WITH GRANT OPTION'))) AS writer_columns,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN (VALUES('USAGE'),('SELECT'),('UPDATE')) p(privilege)
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind='S'
      AND (pg_catalog.has_sequence_privilege(${target.writer},c.oid,p.privilege) IS DISTINCT FROM
        (c.oid=to_regclass('public.system_config_id_seq') AND p.privilege='USAGE')
        OR pg_catalog.has_sequence_privilege(${target.writer},c.oid,p.privilege||' WITH GRANT OPTION'))) AS writer_sequences,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND p.prosecdef AND p.oid<>${mainOid}::oid
        AND pg_catalog.has_function_privilege(${target.writer},p.oid,'EXECUTE')) AS writer_definers,
    (SELECT pg_catalog.has_table_privilege(${target.admin},c.oid,'SELECT')
      AND NOT pg_catalog.has_table_privilege(${target.admin},c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT pg_catalog.has_any_column_privilege(${target.admin},c.oid,'INSERT,UPDATE,REFERENCES')
      FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.admin_wechat_routine_operation')) AS admin_receipt`);
  for (const [name, safe] of Object.entries(roleChecks)) check(name, safe === true);
  const [table] = await tx.execute<{ safe: boolean; columns: Array<[string, string, string | null, boolean]> }>(sql`SELECT
    c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND c.relnatts=16 AND c.relchecks=0 AND c.reloptions IS NULL AND c.relreplident='d' AND c.reltablespace=0
      AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap') AND pg_catalog.pg_get_userbyid(c.relowner)=${target.maintenance}
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid=c.oid)
      AND (SELECT count(*)=1 AND bool_and(contype='p' AND conname='system_config_pkey' AND conkey=ARRAY[1]::smallint[]
        AND convalidated AND NOT condeferrable AND NOT condeferred AND conislocal AND coninhcount=0 AND conparentid=0
        AND conindid=to_regclass('public.system_config_pkey')) FROM pg_catalog.pg_constraint WHERE conrelid=c.oid) AS safe,
    (SELECT jsonb_agg(jsonb_build_array(a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod),
      CASE WHEN a.attnum=1 AND pg_catalog.pg_get_expr(d.adbin,d.adrelid) IN
        ('nextval(''system_config_id_seq''::regclass)','nextval(''public.system_config_id_seq''::regclass)',
         'pg_catalog.nextval(''system_config_id_seq''::regclass)','pg_catalog.nextval(''public.system_config_id_seq''::regclass)') THEN 'serial'
        ELSE pg_catalog.pg_get_expr(d.adbin,d.adrelid) END,
      a.attnotnull AND NOT a.attisdropped AND a.attislocal AND a.attinhcount=0 AND a.attndims=0
        AND a.attidentity='' AND a.attgenerated='' AND NOT a.atthasmissing AND a.attmissingval IS NULL AND a.attcompression=''
        AND a.attcollation=(SELECT typcollation FROM pg_catalog.pg_type WHERE oid=a.atttypid)) ORDER BY a.attnum)
      FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0) AS columns
    FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.system_config')`);
  check('config_table', table?.safe === true);
  check('config_columns', !!table && equal(table.columns, columns.map(column => [...column, true])));
  const actualIndexes = await tx.execute<{ name: string; keys: string; options: string; unique: boolean; primary: boolean; safe: boolean }>(sql`SELECT
    ic.relname AS name,i.indkey::text AS keys,i.indoption::text AS options,i.indisunique AS unique,i.indisprimary AS primary,
    ic.relkind='i' AND ic.relpersistence='p' AND NOT ic.relispartition AND ic.reloptions IS NULL AND ic.reltablespace=0
      AND pg_catalog.pg_get_userbyid(ic.relowner)=${target.maintenance}
      AND ic.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree') AND i.indisvalid AND i.indisready AND i.indislive
      AND i.indimmediate AND NOT i.indisexclusion AND NOT i.indnullsnotdistinct AND NOT i.indisclustered AND NOT i.indisreplident
      AND NOT i.indcheckxmin AND i.indnatts=i.indnkeyatts AND i.indexprs IS NULL AND i.indpred IS NULL
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=ic.oid OR inhparent=ic.oid)
      AND (SELECT count(*)=i.indnkeyatts AND bool_and(op.opcnamespace='pg_catalog'::regnamespace AND op.opcmethod=ic.relam AND op.opcdefault
        AND op.opcname=CASE a.atttypid WHEN 'pg_catalog.int2'::regtype THEN 'int2_ops' WHEN 'pg_catalog.int4'::regtype THEN 'int4_ops'
          WHEN 'pg_catalog.varchar'::regtype THEN 'text_ops' ELSE NULL END AND u.index_collation=a.attcollation)
        FROM unnest(i.indclass::oid[],i.indcollation::oid[],i.indkey::smallint[]) u(opclass,index_collation,attnum)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=u.attnum
        JOIN pg_catalog.pg_opclass op ON op.oid=u.opclass) AS safe
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
    WHERE i.indrelid=to_regclass('public.system_config') ORDER BY ic.relname COLLATE "C"`);
  check('config_indexes', equal(actualIndexes.map(row => [row.name,row.keys,row.options,row.unique,row.primary]), indexes)
    && actualIndexes.every(row => row.safe === true));
  const [sequence] = await tx.execute<{ safe: boolean }>(sql`SELECT c.relkind='S' AND c.relpersistence='p'
    AND c.reloptions IS NULL AND pg_catalog.pg_get_userbyid(c.relowner)=${target.maintenance}
    AND pg_catalog.pg_get_serial_sequence('public.system_config','id')='public.system_config_id_seq'
    AND s.seqtypid='pg_catalog.int4'::regtype AND s.seqstart=1 AND s.seqincrement=1 AND s.seqmax=2147483647
    AND s.seqmin=1 AND s.seqcache=1 AND NOT s.seqcycle
    AND (SELECT count(*)=1 AND bool_and(refobjid=to_regclass('public.system_config') AND refobjsubid=1 AND deptype='a')
      FROM pg_catalog.pg_depend WHERE classid='pg_catalog.pg_class'::regclass AND objid=c.oid AND refclassid='pg_catalog.pg_class'::regclass) AS safe
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_sequence s ON s.seqrelid=c.oid WHERE c.oid=to_regclass('public.system_config_id_seq')`);
  check('config_sequence', sequence?.safe === true);
  const [triggers] = await tx.execute<{ safe: boolean }>(sql`SELECT count(*)=2 AND bool_and(
    t.tgrelid=to_regclass('public.system_config') AND t.tgfoid=${guardOid}::oid AND NOT t.tgisinternal AND t.tgenabled='O'
    AND t.tgnargs=0 AND octet_length(t.tgargs)=0 AND t.tgqual IS NULL AND t.tgconstraint=0 AND t.tgconstrrelid=0 AND t.tgconstrindid=0
    AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgparentid=0 AND t.tgattr::text=''
    AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL AND
      ((t.tgname='routine_config_rows' AND t.tgtype=31) OR (t.tgname='routine_config_truncate' AND t.tgtype=34))) AS safe
    FROM pg_catalog.pg_trigger t WHERE t.tgrelid=to_regclass('public.system_config') OR t.tgfoid=${guardOid}::oid
      OR t.tgname IN ('routine_config_rows','routine_config_truncate')`);
  check('config_triggers', triggers?.safe === true);
  return { present: true, ready: failures.length === 0, binding, failures };
}
