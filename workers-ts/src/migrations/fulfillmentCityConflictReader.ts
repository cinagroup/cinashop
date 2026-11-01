import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { CUSTOMER_CITY_CATALOG, CUSTOMER_CITY_CATALOG_SHA256, CUSTOMER_CITY_CATALOG_SQL } from './customerCityDelivery';
import { inspectRoutineRefundActorPrincipals, type RoutineRefundActorPrincipalNames, type RoutineRefundActorPrincipalBinding } from './routineRefundActorPrincipals';

type Query = Pick<DbClient, 'execute'>;
export const FULFILLMENT_CITY_CONFLICT_FUNCTION = 'fulfillment_city_conflict_v1';
export const FULFILLMENT_CITY_CONFLICT_GATE = [731721, 0] as const;
export const FULFILLMENT_CITY_CONFLICT_SIGNATURE = `public.${FULFILLMENT_CITY_CONFLICT_FUNCTION}(integer)`;
export type FulfillmentCityConflictReadersAddon = { owner: string; app?: true; admin?: true; manager?: true };
export type FulfillmentCityConflictReaderNames = RoutineRefundActorPrincipalNames;
export interface FulfillmentCityConflictReaderBinding extends RoutineRefundActorPrincipalBinding {
  owner: string; ownerOid: string; cityJobOid: string; cityBindingOid: string; deliveryOid: string;
  actors: { app?: true; admin?: true; manager?: true };
}
export interface FulfillmentCityConflictReaderInspection {
  present: boolean; ready: boolean; cityPresent: boolean;
  binding: FulfillmentCityConflictReaderBinding | null; functionOid: string | null; failures: string[];
}
const flags = ['app', 'admin', 'manager'] as const;
const oid = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,9}$/u.test(v) && BigInt(v) <= 4294967295n;
function data(value: unknown, allowed: readonly string[]): Record<string, PropertyDescriptor> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('Invalid city reader declaration');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(k => typeof k !== 'string' || !allowed.includes(k) || !descriptors[k]?.enumerable || !('value' in descriptors[k]))) throw Error('Invalid city reader declaration');
  return descriptors;
}
export function captureFulfillmentCityConflictReadersAddon(value: FulfillmentCityConflictReadersAddon): FulfillmentCityConflictReadersAddon {
  const d = data(value, ['owner', ...flags]), owner: unknown = d.owner?.value;
  if (typeof owner !== 'string') throw Error('Invalid city reader owner');
  pricingIdentifier(owner);
  const result: FulfillmentCityConflictReadersAddon = { owner };
  for (const flag of flags) if (Object.hasOwn(d, flag)) {
    if (d[flag].value !== true) throw Error('Invalid city reader flags');
    result[flag] = true;
  }
  if (!flags.some(flag => result[flag])) throw Error('City reader requires explicit actors');
  return result;
}
function captureNames(value: FulfillmentCityConflictReaderNames): FulfillmentCityConflictReaderNames {
  const d = data(value, ['maintenance', 'app', 'admin']);
  for (const k of ['maintenance', 'app']) if (typeof d[k]?.value !== 'string') throw Error('Invalid city reader names');
  if (d.admin && typeof d.admin.value !== 'string') throw Error('Invalid city reader names');
  const result = { maintenance: d.maintenance.value as string, app: d.app.value as string, ...(d.admin ? { admin: d.admin.value as string } : {}) };
  Object.values(result).forEach(pricingIdentifier); return result;
}
function captureBinding(value: FulfillmentCityConflictReaderBinding): FulfillmentCityConflictReaderBinding {
  const keys = ['database', 'databaseOid', 'maintenance', 'maintenanceOid', 'app', 'appOid', 'admin', 'adminOid', 'manager', 'managerOid', 'owner', 'ownerOid', 'cityJobOid', 'cityBindingOid', 'deliveryOid', 'actors'];
  const d = data(value, keys);
  if (Object.keys(d).length !== keys.length) throw Error('Invalid city reader binding');
  const copy = Object.fromEntries(keys.map(k => [k, d[k]?.value])) as unknown as FulfillmentCityConflictReaderBinding;
  for (const k of ['database', 'maintenance', 'app', 'admin', 'owner'] as const) {
    if (typeof copy[k] !== 'string') throw Error('Invalid city reader binding'); pricingIdentifier(copy[k]);
  }
  for (const k of ['databaseOid', 'maintenanceOid', 'appOid', 'adminOid', 'ownerOid', 'cityJobOid', 'cityBindingOid', 'deliveryOid'] as const)
    if (!oid(copy[k])) throw Error('Invalid city reader binding');
  if ((copy.manager === null) !== (copy.managerOid === null)) throw Error('Invalid city reader binding');
  if (copy.manager !== null) { if (typeof copy.manager !== 'string' || !oid(copy.managerOid)) throw Error('Invalid city reader binding'); pricingIdentifier(copy.manager); }
  const addon = captureFulfillmentCityConflictReadersAddon({ owner: copy.owner, ...Object.fromEntries(Object.entries(data(copy.actors, flags)).map(([k, v]) => [k, v.value])) });
  copy.actors = Object.fromEntries(flags.filter(flag => addon[flag]).map(flag => [flag, true]));
  if (copy.actors.manager && copy.manager === null || new Set([copy.maintenance, copy.app, copy.admin, copy.owner, ...(copy.manager ? [copy.manager] : [])]).size !== (copy.manager ? 5 : 4)
    || new Set([copy.maintenanceOid, copy.appOid, copy.adminOid, copy.ownerOid, ...(copy.managerOid ? [copy.managerOid] : [])]).size !== (copy.managerOid ? 5 : 4)) throw Error('Invalid city reader identities');
  return copy;
}

/** Names/OIDs in this literal are candidates until the inspector re-proves the
 * complete named boundaries, source shape, owner closure and canonical body. */
export function fulfillmentCityConflictReaderBody(value: FulfillmentCityConflictReaderBinding): string {
  const b = captureBinding(value), actors = flags.filter(f => b.actors[f]).map(f => ({ name: b[f], oid: b[`${f}Oid`] }));
  return `
DECLARE
 city_reader_binding constant jsonb := '${JSON.stringify(b)}'::jsonb;
 matches integer; blocked boolean;
BEGIN
 IF p_root_id IS NULL OR p_root_id<=0 OR current_user<>'${b.owner}'
  OR pg_catalog.current_database()<>'${b.database}'
  OR (SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())<>'${b.databaseOid}'::oid
  OR (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)<>'${b.ownerOid}'::oid
  OR pg_catalog.current_setting('server_version_num')::integer/10000<>16
  OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
  OR pg_catalog.current_setting('transaction_read_only')<>'off'
  OR pg_catalog.current_setting('session_replication_role')<>'origin'
  OR pg_catalog.current_setting('role')<>'none'
  OR (SELECT setting::bigint NOT BETWEEN 1 AND 5000 FROM pg_catalog.pg_settings WHERE name='statement_timeout')
  OR (SELECT setting::bigint NOT BETWEEN 1 AND 2000 FROM pg_catalog.pg_settings WHERE name='lock_timeout')
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_stat_activity a ON a.usesysid=r.oid
   WHERE a.pid=pg_catalog.pg_backend_pid() AND r.rolname=session_user AND (${actors.map(a => `(r.rolname='${a.name}' AND r.oid='${a.oid}'::oid)`).join(' OR ')})
    AND r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid))
  OR pg_catalog.to_regclass('public.customer_city_delivery_job') IS DISTINCT FROM '${b.cityJobOid}'::oid
  OR pg_catalog.to_regclass('public.customer_city_delivery_binding') IS DISTINCT FROM '${b.cityBindingOid}'::oid
  OR pg_catalog.to_regclass('public.store_delivery_order') IS DISTINCT FROM '${b.deliveryOid}'::oid
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND pid=pg_catalog.pg_backend_pid()
    AND database='${b.databaseOid}'::oid AND classid=63842 AND objid=p_root_id::oid AND objsubid=2 AND mode='ExclusiveLock' AND granted)
 THEN RAISE EXCEPTION 'City fulfillment reader context requires review' USING ERRCODE='P2131'; END IF;
 IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(${FULFILLMENT_CITY_CONFLICT_GATE[0]},${FULFILLMENT_CITY_CONFLICT_GATE[1]}) THEN
  RAISE EXCEPTION 'City fulfillment reader is busy' USING ERRCODE='P2132';
 END IF;
 BEGIN
  LOCK TABLE ONLY public.store_delivery_order IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'City fulfillment reader is busy' USING ERRCODE='P2132';
 END;
 SELECT pg_catalog.count(*),COALESCE(pg_catalog.bool_or(status IN('PENDING','PROCESSING','UNKNOWN') OR(status='ADMITTED' AND active=1)),false)
 INTO matches,blocked FROM (
  SELECT j.id,j.status,b.active FROM public.customer_city_delivery_job j
   LEFT JOIN public.customer_city_delivery_binding b ON b.job_id=j.id
   WHERE j.root_order_id=p_root_id LIMIT 501
 ) jobs;
 IF matches>500 OR blocked THEN
  RAISE EXCEPTION 'City fulfillment has an unfinished job' USING ERRCODE='P2131';
 END IF;
 RETURN true;
END
`;
}

/** Pure maintenance SQL. The formal forward must first prove the old profile,
 * owner and monotone successor under its exclusive gate and NOWAIT source locks.
 * Runtime receives EXECUTE only. UPDATE is required by PG16 for the table lock;
 * it is granted solely to the dedicated NOLOGIN owner, never a runtime actor. */
export function fulfillmentCityConflictReaderInstallSql(value: FulfillmentCityConflictReaderBinding, options: { replace?: true } = {}): string {
  const b = captureBinding(value), owner = pricingIdentifier(b.owner), declared = data(options, ['replace']);
  if (declared.replace && declared.replace.value !== true) throw Error('Invalid city reader SQL mode');
  const commands = [
    `GRANT USAGE,CREATE ON SCHEMA public TO ${owner}`,
    `GRANT SELECT(id,root_order_id,status) ON public.customer_city_delivery_job TO ${owner}`,
    `GRANT SELECT(job_id,active) ON public.customer_city_delivery_binding TO ${owner}`,
    `GRANT UPDATE ON public.store_delivery_order TO ${owner}`,
    `CREATE ${declared.replace ? 'OR REPLACE ' : ''}FUNCTION public.${FULFILLMENT_CITY_CONFLICT_FUNCTION}(p_root_id integer) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $city_reader$${fulfillmentCityConflictReaderBody(b)}$city_reader$`,
    `REVOKE ALL ON FUNCTION ${FULFILLMENT_CITY_CONFLICT_SIGNATURE} FROM PUBLIC`,
    `ALTER FUNCTION ${FULFILLMENT_CITY_CONFLICT_SIGNATURE} OWNER TO ${owner}`,
    `REVOKE CREATE ON SCHEMA public FROM ${owner}`,
    ...flags.filter(flag => b.actors[flag]).map(flag => `GRANT EXECUTE ON FUNCTION ${FULFILLMENT_CITY_CONFLICT_SIGNATURE} TO ${pricingIdentifier(b[flag]!)}`),
  ];
  return commands.join(';\n') + ';';
}

// Qualifying the fixed legacy structural SQL preserves its canonical result
// while excluding TEMP/user function and system-catalog shadows.
const citySql = CUSTOMER_CITY_CATALOG_SQL.replace(/(?<![.\w])\b(pg_class|pg_attribute|pg_attrdef|pg_constraint|pg_index|pg_opclass|pg_namespace|pg_am|pg_trigger|pg_inherits|jsonb_build_object|jsonb_agg|format_type|pg_get_expr|pg_get_constraintdef|unnest|to_regclass|count)\b/gu, 'pg_catalog.$1');
function canonicalCityShape(value: unknown): unknown {
  // PG deparsers qualify these same fixed public objects when public is not
  // visible. Only their known slots/spellings are normalized; another schema,
  // expression, function or constraint still changes the complete hash.
  const shape = structuredClone(value) as Record<string, { columns?: Array<{ default: unknown; collation: unknown }>; constraints?: Array<{ definition: unknown }> }>;
  for (const table of Object.values(shape)) {
    for (const column of table?.columns ?? []) {
      if (typeof column.default === 'string') column.default = column.default.replace(/'public\.(customer_city_delivery_(?:job|attempt)_id_seq)'::regclass/gu, "'$1'::regclass");
      if (column.collation === 'pg_catalog.\"default\"') column.collation = '\"default\"';
    }
    for (const constraint of table?.constraints ?? []) if (typeof constraint.definition === 'string')
      constraint.definition = constraint.definition.replace(/REFERENCES public\.(customer_city_delivery_(?:job|attempt))\(/gu, 'REFERENCES $1(');
  }
  return shape;
}
async function city(tx: Query, maintenanceOid?: string) {
  const tables = CUSTOMER_CITY_CATALOG.map(t => t.table), relations = [...tables, ...tables.map(t => `${t}_pkey`), ...CUSTOMER_CITY_CATALOG.flatMap(t => t.indexes.map(i => i.name)), ...tables.slice(0, 2).map(t => `${t}_id_seq`)];
  const [scope] = await tx.execute<{ present: boolean; complete: boolean; job: string; binding: string; delivery: string }>(sql`SELECT
    EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND (pg_catalog.starts_with(c.relname,'customer_city_delivery_') OR pg_catalog.starts_with(c.relname,'ccdjob_') OR pg_catalog.starts_with(c.relname,'ccdattempt_') OR pg_catalog.starts_with(c.relname,'ccdbinding_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_type t WHERE t.typnamespace='public'::regnamespace AND ((pg_catalog.starts_with(t.typname,'customer_city_delivery_') OR pg_catalog.starts_with(t.typname,'ccdjob_') OR pg_catalog.starts_with(t.typname,'ccdattempt_') OR pg_catalog.starts_with(t.typname,'ccdbinding_')) OR pg_catalog.starts_with(t.typname,'_customer_city_delivery_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND (pg_catalog.starts_with(p.proname,'customer_city_delivery_') OR pg_catalog.starts_with(p.proname,'ccdjob_') OR pg_catalog.starts_with(p.proname,'ccdattempt_') OR pg_catalog.starts_with(p.proname,'ccdbinding_'))) AS present,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND (pg_catalog.starts_with(c.relname,'customer_city_delivery_') OR pg_catalog.starts_with(c.relname,'ccdjob_') OR pg_catalog.starts_with(c.relname,'ccdattempt_') OR pg_catalog.starts_with(c.relname,'ccdbinding_'))
      AND c.relname NOT IN (${sql.join(relations.map(v => sql`${v}`), sql`, `)}))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_type t WHERE t.typnamespace='public'::regnamespace
      AND ((pg_catalog.starts_with(t.typname,'customer_city_delivery_') OR pg_catalog.starts_with(t.typname,'ccdjob_') OR pg_catalog.starts_with(t.typname,'ccdattempt_') OR pg_catalog.starts_with(t.typname,'ccdbinding_')) OR pg_catalog.starts_with(t.typname,'_customer_city_delivery_'))
      AND t.typname NOT IN (${sql.join([...tables, ...tables.map(t => '_' + t)].map(v => sql`${v}`), sql`, `)}))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND (pg_catalog.starts_with(p.proname,'customer_city_delivery_') OR pg_catalog.starts_with(p.proname,'ccdjob_') OR pg_catalog.starts_with(p.proname,'ccdattempt_') OR pg_catalog.starts_with(p.proname,'ccdbinding_')))
    AND (SELECT pg_catalog.count(*)=4 AND pg_catalog.bool_and(c.relowner=${maintenanceOid ?? '0'}::oid AND c.relkind='r' AND c.relpersistence='p'
      AND NOT(c.relrowsecurity OR c.relforcerowsecurity OR c.relispartition OR c.relhasrules)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attisdropped)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid))
      FROM pg_catalog.pg_class c WHERE c.oid IN(pg_catalog.to_regclass('public.customer_city_delivery_job'),pg_catalog.to_regclass('public.customer_city_delivery_attempt'),
        pg_catalog.to_regclass('public.customer_city_delivery_binding'),pg_catalog.to_regclass('public.store_delivery_order'))) AS complete,
    pg_catalog.to_regclass('public.customer_city_delivery_job')::oid::text AS job,
    pg_catalog.to_regclass('public.customer_city_delivery_binding')::oid::text AS binding,pg_catalog.to_regclass('public.store_delivery_order')::oid::text AS delivery`);
  if (!scope?.present) return { present: false, ready: false, scope };
  if (scope.complete !== true) return { present: true, ready: false, scope };
  const rows = await tx.execute<{ shape: unknown }>(sql.raw(citySql));
  const [station] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.count(*)=2 AND pg_catalog.bool_and(a.attnotnull AND a.attidentity='' AND a.attgenerated='' AND
    ((a.attname='business' AND a.atttypid='pg_catalog.int4'::regtype AND a.atttypmod=-1 AND pg_catalog.pg_get_expr(d.adbin,d.adrelid)='0') OR
     (a.attname='city_shop_id' AND a.atttypid='pg_catalog.varchar'::regtype AND a.atttypmod=259 AND pg_catalog.pg_get_expr(d.adbin,d.adrelid)=${"''::character varying"})))
    AS ready FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=pg_catalog.to_regclass('public.system_store') AND a.attname IN('business','city_shop_id') AND a.attnum>0 AND NOT a.attisdropped`);
  return { present: true, ready: rows.length === 1 && await outRequestHash(canonicalCityShape(rows[0].shape)) === CUSTOMER_CITY_CATALOG_SHA256 && station?.ready === true, scope };
}

async function ownerSafe(tx: Query, owner: string, installed: boolean): Promise<{ ready: boolean; oid: string | null }> {
  const columns = installed ? [ ['customer_city_delivery_job', 'id'], ['customer_city_delivery_job', 'root_order_id'], ['customer_city_delivery_job', 'status'],
    ['customer_city_delivery_binding', 'job_id'], ['customer_city_delivery_binding', 'active'] ] : [];
  const [row] = await tx.execute<{ ready: boolean; oid: string }>(sql`WITH owner AS(SELECT * FROM pg_catalog.pg_roles WHERE rolname=${owner}),
    relations AS(SELECT c.*,n.nspname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'),
    wanted AS(SELECT x->>0 AS name,x->>1 AS column_name FROM pg_catalog.jsonb_array_elements(${JSON.stringify(columns)}::jsonb) x)
    SELECT o.oid::text AS oid,
      NOT(o.rolcanlogin OR o.rolsuper OR o.rolcreatedb OR o.rolcreaterole OR o.rolinherit OR o.rolreplication OR o.rolbypassrls) AND o.rolconfig IS NULL
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=o.oid OR roleid=o.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usesysid=o.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_db_role_setting WHERE setrole=o.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=o.oid OR(nspname !~ '^pg_' AND pg_catalog.has_schema_privilege(o.oid,oid,'CREATE')))
      AND NOT pg_catalog.has_database_privilege(o.oid,pg_catalog.current_database(),'CREATE')
      AND NOT pg_catalog.has_parameter_privilege(o.oid,'session_replication_role','SET,ALTER SYSTEM')
      AND (${!installed} OR pg_catalog.has_schema_privilege(o.oid,'public','USAGE'))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d WHERE d.refclassid='pg_catalog.pg_authid'::regclass AND d.refobjid=o.oid AND d.deptype='o'
        AND NOT(${installed} AND d.dbid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AND d.classid='pg_catalog.pg_proc'::regclass
          AND d.objid=pg_catalog.to_regprocedure(${FULFILLMENT_CITY_CONFLICT_SIGNATURE})))
      AND NOT EXISTS(SELECT 1 FROM relations c WHERE CASE WHEN c.relkind IN('r','p','v','m','f') THEN c.relowner=o.oid
        OR EXISTS(SELECT 1 FROM pg_catalog.unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(privilege)
          WHERE pg_catalog.has_table_privilege(o.oid,c.oid,p.privilege) IS DISTINCT FROM (${installed} AND c.nspname='public' AND c.relname='store_delivery_order' AND p.privilege='UPDATE'))
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a CROSS JOIN pg_catalog.unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p(privilege)
          WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND pg_catalog.has_column_privilege(o.oid,c.oid,a.attnum,p.privilege) IS DISTINCT FROM
            (${installed} AND c.nspname='public' AND c.relname='store_delivery_order' AND p.privilege='UPDATE'
              OR p.privilege='SELECT' AND c.nspname='public' AND EXISTS(SELECT 1 FROM wanted w WHERE w.name=c.relname AND w.column_name=a.attname)))
        OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(c.relacl) a WHERE a.grantee=o.oid AND (a.is_grantable OR NOT(${installed} AND c.nspname='public' AND c.relname='store_delivery_order' AND a.privilege_type='UPDATE')))
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute att CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND att.attnum>0 AND a.grantee=o.oid
          AND(a.is_grantable OR a.privilege_type<>'SELECT' OR c.nspname<>'public' OR NOT EXISTS(SELECT 1 FROM wanted w WHERE w.name=c.relname AND w.column_name=att.attname)))
        WHEN c.relkind='S' THEN c.relowner=o.oid OR pg_catalog.has_sequence_privilege(o.oid,c.oid,'USAGE,SELECT,UPDATE') ELSE c.relowner=o.oid END)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
        AND(p.proowner=o.oid OR(p.prosecdef AND pg_catalog.has_function_privilege(o.oid,p.oid,'EXECUTE')) OR pg_catalog.has_function_privilege(o.oid,p.oid,'EXECUTE WITH GRANT OPTION')
          OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(p.proacl) a WHERE a.grantee=o.oid))
        AND NOT(${installed} AND p.oid=pg_catalog.to_regprocedure(${FULFILLMENT_CITY_CONFLICT_SIGNATURE}) AND p.proowner=o.oid))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d WHERE d.defaclrole=o.oid OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(d.defaclacl) a WHERE a.grantee=o.oid)) AS ready
    FROM owner o`);
  return { ready: row?.ready === true, oid: oid(row?.oid) ? row.oid : null };
}
interface FunctionRow extends Record<string, unknown> { oid: string; source: string | null; safe: boolean; owner: string; ownerOid: string; acl: unknown }
async function orphaned(tx: Query): Promise<boolean> {
  const [row] = await tx.execute<{ present: boolean }>(sql`SELECT
    EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND pg_catalog.starts_with(c.relname,'fulfillment_city_conflict_'))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
      AND (pg_catalog.starts_with(t.typname,'fulfillment_city_conflict_') OR pg_catalog.starts_with(t.typname,'_fulfillment_city_conflict_'))) AS present`);
  return row?.present === true;
}
async function functions(tx: Query) {
  return Array.from(await tx.execute<FunctionRow>(sql`SELECT p.oid::text AS oid,CASE WHEN pg_catalog.octet_length(p.prosrc)<=16384 THEN p.prosrc ELSE NULL END AS source,
    pg_catalog.pg_get_userbyid(p.proowner) AS owner,p.proowner::text AS "ownerOid",p.proacl::text AS acl,
    p.pronamespace='public'::regnamespace AND p.proname=${FULFILLMENT_CITY_CONFLICT_FUNCTION} AND p.prokind='f' AND p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
    AND p.prorettype='pg_catalog.bool'::regtype AND p.proargtypes='23'::oidvector AND p.pronargs=1 AND p.proargnames=ARRAY['p_root_id']::text[]
    AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND l.lanname='plpgsql' AND l.lanpltrusted AND NOT p.proleakproof AND NOT p.proisstrict AND NOT p.proretset
    AND p.provariadic=0 AND p.pronargdefaults=0 AND p.proargdefaults IS NULL AND p.prosupport=0 AND p.probin IS NULL AND p.prosqlbody IS NULL
    AND p.procost=100 AND p.prorows=0 AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgfoid=p.oid) AS safe
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND pg_catalog.starts_with(p.proname,'fulfillment_city_conflict_') ORDER BY p.oid LIMIT 3`));
}
function fromBody(row: FunctionRow): FulfillmentCityConflictReaderBinding {
  const match = /^\nDECLARE\n city_reader_binding constant jsonb := '([^']{1,8192})'::jsonb;/u.exec(row.source ?? '');
  if (!match) throw Error('City reader candidates absent');
  return captureBinding(JSON.parse(match[1]));
}

/** Metadata only. The formal named boundary proves actor identities; function
 * ACLs never supply an identity. This does not authenticate the current session,
 * grant privileges, execute the capability, acquire locks or call a full auditor. */
export async function inspectFulfillmentCityConflictReader(tx: Query, value?: FulfillmentCityConflictReaderNames): Promise<FulfillmentCityConflictReaderInspection> {
  const result: FulfillmentCityConflictReaderInspection = { present: false, ready: false, cityPresent: false, binding: null, functionOid: null, failures: [] };
  try {
    let names: FulfillmentCityConflictReaderNames | undefined = value === undefined ? undefined : captureNames(value);
    const before = await functions(tx), orphan = await orphaned(tx); result.present = before.length > 0 || orphan;
    if (orphan) { result.cityPresent = (await city(tx)).present; result.failures.push('orphan_namespace'); return result; }
    let b: FulfillmentCityConflictReaderBinding | undefined;
    if (before.length === 1) {
      try { b = fromBody(before[0]); names ??= { maintenance: b.maintenance, app: b.app, admin: b.admin }; } catch { /* candidates confer no authority */ }
    }
    if (!names) { result.cityPresent = (await city(tx)).present; result.failures.push(result.present ? 'function_candidates' : 'absent'); return result; }
    const principal = await inspectRoutineRefundActorPrincipals(tx, names);
    const source = await city(tx, principal.binding?.maintenanceOid); result.cityPresent = source.present;
    if (!result.present) { result.failures.push(source.present && !source.ready ? 'source_catalog' : 'absent'); return result; }
    if (!b || before.length !== 1 || !principal.ready || !principal.binding) { result.failures.push('named_principals'); return result; }
    const expected = { ...principal.binding, owner: b.owner, ownerOid: b.ownerOid, cityJobOid: source.scope?.job, cityBindingOid: source.scope?.binding, deliveryOid: source.scope?.delivery, actors: b.actors };
    if (!source.ready || JSON.stringify(b) !== JSON.stringify(expected) || before[0].safe !== true || before[0].owner !== b.owner || before[0].ownerOid !== b.ownerOid
      || before[0].source !== fulfillmentCityConflictReaderBody(b)) { result.failures.push('canonical_catalog'); return result; }
    const owner = await ownerSafe(tx, b.owner, true);
    const grantees = [b.ownerOid, ...flags.filter(flag => b!.actors[flag]).map(flag => b![`${flag}Oid`]!)];
    const [acl] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.count(*)=${grantees.length} AND pg_catalog.count(DISTINCT a.grantee)=${grantees.length} AND pg_catalog.bool_and(a.privilege_type='EXECUTE' AND NOT a.is_grantable
      AND a.grantee::text IN (${sql.join(grantees.map(v => sql`${v}`), sql`, `)}) AND a.grantor=${b.ownerOid}::oid) AS ready
      FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a WHERE p.oid=${before[0].oid}::oid`);
    if (!owner.ready || owner.oid !== b.ownerOid || acl?.ready !== true) { result.failures.push('owner_or_acl'); return result; }
    if (JSON.stringify(before) !== JSON.stringify(await functions(tx))) { result.failures.push('metadata_changed'); return result; }
    result.ready = true; result.binding = b; result.functionOid = before[0].oid; return result;
  } catch { result.failures.push('catalog_query'); return result; }
}

/** Fresh dedicated owner and exact installed owner are separate states. This
 * assembles a successor binding only: it neither installs nor repairs anything. */
export async function resolveFulfillmentCityConflictReaderBinding(tx: Query, value: FulfillmentCityConflictReaderNames, input: FulfillmentCityConflictReadersAddon): Promise<{ binding: FulfillmentCityConflictReaderBinding; ownerState: 'fresh' | 'installed' }> {
  const names = captureNames(value), addon = captureFulfillmentCityConflictReadersAddon(input);
  const principal = await inspectRoutineRefundActorPrincipals(tx, names);
  if (!principal.ready || !principal.binding) throw Error('City reader named identities require review');
  const p = principal.binding, source = await city(tx, p.maintenanceOid);
  if (!source.ready || !source.scope || !oid(source.scope.job) || !oid(source.scope.binding) || !oid(source.scope.delivery)
    || [p.maintenance, p.app, p.admin, p.manager, 'cinashop_customer_financial_v1'].includes(addon.owner)) throw Error('City reader source or owner requires review');
  const existing = await inspectFulfillmentCityConflictReader(tx, names);
  const ownerState = existing.present ? 'installed' : 'fresh';
  if (existing.present && (!existing.ready || !existing.binding || existing.binding.owner !== addon.owner
    || flags.some(flag => existing.binding!.actors[flag] && !addon[flag]))) throw Error('City reader installed state requires review');
  const owner = await ownerSafe(tx, addon.owner, ownerState === 'installed');
  if (!owner.ready || !owner.oid) throw Error('City reader dedicated owner requires review');
  const binding = captureBinding({ ...p, owner: addon.owner, ownerOid: owner.oid, cityJobOid: source.scope.job,
    cityBindingOid: source.scope.binding, deliveryOid: source.scope.delivery,
    actors: Object.fromEntries(flags.filter(flag => addon[flag]).map(flag => [flag, true])) });
  return { binding, ownerState };
}
