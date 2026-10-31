import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';
import { pricingIdentifier } from './checkoutPricingLockCatalog';

type Query = Pick<DbClient, 'execute'>;
export interface RoutineIdentityOwnershipNames { maintenance: string; app: string; admin: string }
export interface RoutineIdentityOwnershipCatalog {
  present: boolean;
  ready: boolean;
  binding: { maintenance: string; maintenanceOid: string; app: string | null; appOid: string | null } | null;
  failures: string[];
}
export const ROUTINE_IDENTITY_OWNERSHIP_RUNTIME_PRIVILEGES = { app: ['SELECT', 'INSERT'], admin: [] } as const;
// Separate from witness731669, initiation731670 and original evidence731714.
export const ROUTINE_IDENTITY_OWNERSHIP_GATE = [731716, 0] as const;
export const ROUTINE_IDENTITY_OWNERSHIP_IMMUTABLE_BODY = `BEGIN
  RAISE EXCEPTION 'Routine identity ownership is immutable' USING ERRCODE='42501';
END`;

/** Explicit prospective storage only. The service authenticates the original
 * observation and exact live user/binding before inserting. This does not
 * backfill history, reassign a UID, activate AppID switching or change the
 * existing global wechat_user openid uniqueness. No FK/default/sequence. */
export const ROUTINE_IDENTITY_OWNERSHIP_SQL = `
CREATE TABLE public.routine_identity_ownership (
  ownership_id varchar(64) NOT NULL,
  app_id varchar(32) NOT NULL,
  openid varchar(100) NOT NULL,
  uid integer NOT NULL,
  binding_id integer NOT NULL,
  observation_id uuid NOT NULL,
  format_version smallint NOT NULL,
  observed_at bigint NOT NULL,
  created_at bigint NOT NULL,
  signature varchar(64) NOT NULL,
  CONSTRAINT rio_pk PRIMARY KEY(ownership_id),
  CONSTRAINT rio_identity_uq UNIQUE(app_id,openid),
  CONSTRAINT rio_binding_uq UNIQUE(binding_id),
  CONSTRAINT rio_id_ck CHECK(ownership_id ~ '^[a-f0-9]{64}$'),
  CONSTRAINT rio_app_ck CHECK(app_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  CONSTRAINT rio_openid_ck CHECK(openid ~ '^[A-Za-z0-9_-]{1,100}$'),
  CONSTRAINT rio_uid_ck CHECK(uid > 0),
  CONSTRAINT rio_binding_ck CHECK(binding_id > 0),
  CONSTRAINT rio_format_ck CHECK(format_version = 1),
  CONSTRAINT rio_observed_ck CHECK(observed_at > 0),
  CONSTRAINT rio_created_ck CHECK(created_at > 0),
  CONSTRAINT rio_signature_ck CHECK(signature ~ '^[a-f0-9]{64}$')
);
CREATE INDEX rio_app_uid_idx ON public.routine_identity_ownership(app_id,uid,binding_id);
CREATE FUNCTION public.routine_identity_ownership_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $rio$${ROUTINE_IDENTITY_OWNERSHIP_IMMUTABLE_BODY}$rio$;
CREATE TRIGGER rio_immutable_rows BEFORE UPDATE OR DELETE ON public.routine_identity_ownership
FOR EACH ROW EXECUTE FUNCTION public.routine_identity_ownership_immutable_v1();
CREATE TRIGGER rio_immutable_truncate BEFORE TRUNCATE ON public.routine_identity_ownership
FOR EACH STATEMENT EXECUTE FUNCTION public.routine_identity_ownership_immutable_v1();
REVOKE ALL ON TABLE public.routine_identity_ownership FROM PUBLIC;
REVOKE ALL ON FUNCTION public.routine_identity_ownership_immutable_v1() FROM PUBLIC;
`;
export const ROUTINE_IDENTITY_OWNERSHIP_EXPECTED_COLUMNS = [
  [1, 'ownership_id', 'character varying(64)', true, '"default"'],
  [2, 'app_id', 'character varying(32)', true, '"default"'],
  [3, 'openid', 'character varying(100)', true, '"default"'],
  [4, 'uid', 'integer', true, null], [5, 'binding_id', 'integer', true, null],
  [6, 'observation_id', 'uuid', true, null], [7, 'format_version', 'smallint', true, null],
  [8, 'observed_at', 'bigint', true, null], [9, 'created_at', 'bigint', true, null],
  [10, 'signature', 'character varying(64)', true, '"default"'],
];
export const ROUTINE_IDENTITY_OWNERSHIP_EXPECTED_CONSTRAINTS: Record<string, string> = {
  rio_pk: 'PRIMARY KEY (ownership_id)', rio_identity_uq: 'UNIQUE (app_id, openid)', rio_binding_uq: 'UNIQUE (binding_id)',
  rio_id_ck: "CHECK (((ownership_id)::text ~ '^[a-f0-9]{64}$'::text))",
  rio_app_ck: "CHECK (((app_id)::text ~ '^[A-Za-z0-9_-]{1,32}$'::text))",
  rio_openid_ck: "CHECK (((openid)::text ~ '^[A-Za-z0-9_-]{1,100}$'::text))",
  rio_uid_ck: 'CHECK ((uid > 0))', rio_binding_ck: 'CHECK ((binding_id > 0))',
  rio_format_ck: 'CHECK ((format_version = 1))',
  rio_observed_ck: 'CHECK ((observed_at > 0))',
  rio_created_ck: 'CHECK ((created_at > 0))',
  rio_signature_ck: "CHECK (((signature)::text ~ '^[a-f0-9]{64}$'::text))",
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Read-only exact PG16 catalog/namespace inspection. With no names, only the
 * owner-only pre-GRANT state or one restricted App's exact SELECT/INSERT ACL is
 * accepted. Supplied names require the commissioned shape, including no Admin
 * or other principal grant. This never authenticates an observation or prospective ownership claim. */
export async function inspectRoutineIdentityOwnershipCatalog(tx: Query,
  declaredNames?: RoutineIdentityOwnershipNames): Promise<RoutineIdentityOwnershipCatalog> {
  const names = declaredNames ? { maintenance: declaredNames.maintenance, app: declaredNames.app, admin: declaredNames.admin } : undefined;
  if (names) {
    try {
      [names.maintenance, names.app, names.admin].forEach(pricingIdentifier);
      if (new Set([names.maintenance, names.app, names.admin]).size !== 3) throw Error('Distinct names required');
    } catch { return { present: true, ready: false, binding: null, failures: ['binding'] }; }
  }
  const [inventory] = await tx.execute<{ present: boolean; namespace: boolean }>(sql`SELECT
    EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
      AND (starts_with(relname,'routine_identity_ownership') OR starts_with(relname,'rio_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
      AND (starts_with(proname,'routine_identity_ownership') OR starts_with(proname,'rio_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace
      AND (starts_with(typname,'routine_identity_ownership') OR starts_with(typname,'_routine_identity_ownership')
        OR starts_with(typname,'rio_') OR starts_with(typname,'_rio_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE connamespace='public'::regnamespace
      AND (starts_with(conname,'routine_identity_ownership') OR starts_with(conname,'rio_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE starts_with(tgname,'routine_identity_ownership') OR starts_with(tgname,'rio_')) AS present,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
      AND (starts_with(relname,'routine_identity_ownership') OR starts_with(relname,'rio_'))
      AND relname NOT IN ('routine_identity_ownership','rio_pk','rio_identity_uq','rio_binding_uq','rio_app_uid_idx'))
    AND (SELECT count(*)=1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
      AND (starts_with(proname,'routine_identity_ownership') OR starts_with(proname,'rio_')))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE connamespace='public'::regnamespace
      AND (starts_with(conname,'routine_identity_ownership') OR starts_with(conname,'rio_'))
      AND conrelid IS DISTINCT FROM to_regclass('public.routine_identity_ownership'))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE
      (starts_with(tgname,'routine_identity_ownership') OR starts_with(tgname,'rio_'))
      AND tgrelid IS DISTINCT FROM to_regclass('public.routine_identity_ownership')) AS namespace`);
  if (!inventory || typeof inventory.present !== 'boolean')
    return { present: true, ready: false, binding: null, failures: ['inventory'] };
  if (!inventory.present) return { present: false, ready: false, binding: null, failures: [] };
  const failures: string[] = [];
  const check = (key: string, value: boolean) => { if (!value) failures.push(key); };
  check('namespace', inventory.namespace === true);
  const [row] = await tx.execute<Record<string, unknown>>(sql`SELECT
    pg_catalog.pg_get_userbyid(c.relowner) AS maintenance,c.relowner::text AS maintenance_oid,
    current_setting('server_version_num')::integer/10000=16
    AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
    AND c.relnatts=10 AND c.relchecks=9 AND c.reloptions IS NULL AND c.relreplident='d' AND c.reltablespace=0
    AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid=c.relowner AND r.rolsuper AND r.rolcanlogin
      AND (${names?.maintenance ?? null}::text IS NULL OR r.rolname=${names?.maintenance ?? null}::text))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype NOT IN ('p','u','c','n'))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attnum>0
      AND (attisdropped OR atthasdef OR attidentity<>'' OR attgenerated<>'' OR attacl IS NOT NULL))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attrdef WHERE adrelid=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend WHERE classid='pg_catalog.pg_class'::regclass AND objid=c.oid AND deptype='e') AS safe,
    (SELECT jsonb_agg(jsonb_build_array(attnum,attname,format_type(atttypid,atttypmod),attnotnull,
      CASE WHEN attcollation=0 THEN NULL ELSE attcollation::regcollation::text END) ORDER BY attnum)
      FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attnum>0) AS columns,
    (SELECT count(*)=12 AND bool_and(convalidated AND NOT condeferrable AND NOT condeferred AND conislocal
      AND coninhcount=0 AND conparentid=0 AND connamespace='public'::regnamespace)
      FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype IN ('p','u','c')) AS constraint_count,
    (SELECT jsonb_object_agg(conname,pg_get_constraintdef(oid,false)) FROM pg_catalog.pg_constraint
      WHERE conrelid=c.oid AND contype IN ('p','u','c')) AS constraints,
    (SELECT count(*)=4 AND bool_and(i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
      AND NOT i.indisexclusion AND NOT i.indisclustered AND NOT i.indisreplident AND NOT i.indnullsnotdistinct
      AND i.indexprs IS NULL AND i.indpred IS NULL AND i.indnatts=i.indnkeyatts
      AND ic.relkind='i' AND ic.relpersistence='p' AND ic.reloptions IS NULL AND ic.reltablespace=0
      AND ic.relowner=c.relowner AND ic.relnamespace=c.relnamespace AND ic.relacl IS NULL
      AND ic.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')
      AND i.indcollation::text=CASE ic.relname
        WHEN 'rio_binding_uq' THEN '0' WHEN 'rio_identity_uq' THEN dc.oid::text||' '||dc.oid::text
        WHEN 'rio_app_uid_idx' THEN dc.oid::text||' 0 0' ELSE dc.oid::text END
      AND i.indclass::text=CASE ic.relname
        WHEN 'rio_binding_uq' THEN ip.oid::text WHEN 'rio_identity_uq' THEN op.oid::text||' '||op.oid::text
        WHEN 'rio_app_uid_idx' THEN op.oid::text||' '||ip.oid::text||' '||ip.oid::text ELSE op.oid::text END
      AND ((ic.relname='rio_pk' AND i.indisprimary AND i.indisunique AND i.indnkeyatts=1 AND i.indkey::text='1' AND i.indoption::text='0')
        OR (ic.relname='rio_identity_uq' AND NOT i.indisprimary AND i.indisunique AND i.indnkeyatts=2 AND i.indkey::text='2 3' AND i.indoption::text='0 0')
        OR (ic.relname='rio_binding_uq' AND NOT i.indisprimary AND i.indisunique AND i.indnkeyatts=1 AND i.indkey::text='5' AND i.indoption::text='0')
        OR (ic.relname='rio_app_uid_idx' AND NOT i.indisprimary AND NOT i.indisunique AND i.indnkeyatts=3 AND i.indkey::text='2 4 5' AND i.indoption::text='0 0 0')))
      FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
      CROSS JOIN pg_catalog.pg_collation dc CROSS JOIN pg_catalog.pg_opclass op CROSS JOIN pg_catalog.pg_opclass ip
      WHERE i.indrelid=c.oid AND dc.collname='default' AND dc.collnamespace='pg_catalog'::regnamespace
        AND op.opcname='text_ops' AND op.opcnamespace='pg_catalog'::regnamespace
        AND op.opcmethod=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')
        AND ip.opcname='int4_ops' AND ip.opcnamespace='pg_catalog'::regnamespace
        AND ip.opcmethod=op.opcmethod) AS indexes,
    (SELECT count(*)=2 AND bool_and(NOT t.tgisinternal AND t.tgenabled='O' AND t.tgnargs=0 AND t.tgqual IS NULL
      AND t.tgconstraint=0 AND t.tgfoid=f.oid AND t.tgattr::text='' AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
      AND ((t.tgname='rio_immutable_rows' AND t.tgtype=27) OR (t.tgname='rio_immutable_truncate' AND t.tgtype=34)))
      FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid) AS triggers,
    f.proowner=c.relowner AND f.prosrc=${ROUTINE_IDENTITY_OWNERSHIP_IMMUTABLE_BODY}
    AND f.prorettype='pg_catalog.trigger'::regtype AND f.pronargs=0 AND f.proargtypes::text=''
    AND NOT f.prosecdef AND NOT f.proleakproof AND f.provolatile='v' AND f.prokind='f'
    AND f.proconfig=ARRAY['search_path=pg_catalog'] AND NOT f.proisstrict AND NOT f.proretset AND f.proparallel='u'
    AND f.procost=100 AND f.prorows=0 AND f.prosupport=0 AND f.provariadic=0 AND f.pronargdefaults=0
    AND f.proargdefaults IS NULL AND f.proallargtypes IS NULL AND f.proargmodes IS NULL AND f.proargnames IS NULL
    AND f.probin IS NULL AND f.prosqlbody IS NULL AND f.protrftypes IS NULL
    AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql' AND lanpltrusted)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgfoid=f.oid AND tgrelid<>c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend WHERE classid='pg_catalog.pg_proc'::regclass AND objid=f.oid AND deptype='e')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a
      WHERE a.grantee<>f.proowner OR a.grantor<>f.proowner) AS function,
    NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee WHERE a.grantee<>c.relowner
      AND (a.grantee=0 OR a.grantor<>c.relowner OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')
        OR NOT r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid))) AS acl_safe,
    COALESCE((SELECT jsonb_agg(jsonb_build_array(r.rolname,r.oid::text,a.privilege_type,a.is_grantable)
      ORDER BY r.rolname COLLATE "C",a.privilege_type COLLATE "C")
      FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee WHERE a.grantee<>c.relowner),'[]'::jsonb) AS grants
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_proc f
      ON f.oid=to_regprocedure('public.routine_identity_ownership_immutable_v1()')
    WHERE c.oid=to_regclass('public.routine_identity_ownership')`);
  if (!row) return { present: true, ready: false, binding: null, failures: [...failures, 'catalog'] };
  for (const key of ['safe', 'constraint_count', 'indexes', 'triggers', 'function', 'acl_safe']) check(key, row[key] === true);
  check('columns', same(row.columns, ROUTINE_IDENTITY_OWNERSHIP_EXPECTED_COLUMNS));
  const actual = row.constraints as Record<string, string> | null;
  check('constraints', !!actual && Object.keys(actual).length === Object.keys(ROUTINE_IDENTITY_OWNERSHIP_EXPECTED_CONSTRAINTS).length
    && Object.entries(ROUTINE_IDENTITY_OWNERSHIP_EXPECTED_CONSTRAINTS).every(([key, value]) => actual[key] === value));
  const grants = row.grants as Array<[string, string, string, boolean]> | null;
  let app: string | null = null, appOid: string | null = null;
  if (Array.isArray(grants) && grants.length === 2 && grants.every(value => Array.isArray(value) && value.length === 4)
    && grants[0][0] === grants[1][0] && grants[0][1] === grants[1][1]
    && grants[0][2] === 'INSERT' && grants[1][2] === 'SELECT' && grants.every(value => value[3] === false)) {
    app = grants[0][0]; appOid = grants[0][1];
  } else check('acl', Array.isArray(grants) && grants.length === 0);
  const maintenance = typeof row.maintenance === 'string' ? row.maintenance : null;
  const maintenanceOid = typeof row.maintenance_oid === 'string' ? row.maintenance_oid : null;
  check('binding', maintenance !== null && maintenanceOid !== null && (app === null || app !== maintenance)
    && (!names || maintenance === names.maintenance && app === names.app));
  const [namespace] = await tx.execute<{ safe: boolean; roles: boolean }>(sql`SELECT
    (SELECT count(*)=2 AND bool_and(t.typowner=${maintenanceOid}::oid AND t.typacl IS NULL
      AND ((t.typname='routine_identity_ownership' AND t.typtype='c'
        AND t.typrelid=to_regclass('public.routine_identity_ownership')
        AND t.oid=(SELECT reltype FROM pg_catalog.pg_class WHERE oid=t.typrelid)
        AND t.typarray=to_regtype('public._routine_identity_ownership'))
      OR (t.typname='_routine_identity_ownership' AND t.typtype='b'
        AND t.typelem=to_regtype('public.routine_identity_ownership')
        AND t.oid=(SELECT typarray FROM pg_catalog.pg_type WHERE oid=t.typelem))))
      FROM pg_catalog.pg_type t WHERE t.typnamespace='public'::regnamespace
      AND (starts_with(t.typname,'routine_identity_ownership') OR starts_with(t.typname,'_routine_identity_ownership')
        OR starts_with(t.typname,'rio_') OR starts_with(t.typname,'_rio_')))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
      WHERE (d.defaclrole=${maintenanceOid}::oid AND d.defaclnamespace IN (0,'public'::regnamespace)
        AND d.defaclobjtype IN ('r','f','S') AND a.grantee<>d.defaclrole)
      OR a.grantee IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (${app},${names?.admin ?? null}))
      OR (a.grantee=0 AND d.defaclobjtype IN ('r','S'))) AS safe,
    (SELECT count(*)=${names ? 2 : app ? 1 : 0} AND COALESCE(bool_and(r.rolcanlogin
      AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
      AND pg_catalog.has_database_privilege(r.oid,current_database(),'CONNECT') AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE')
      AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')),true)
      FROM pg_catalog.pg_roles r WHERE r.rolname IN (${app},${names?.admin ?? null})) AS roles`);
  check('types_defaults', namespace?.safe === true);
  check('runtime_roles', namespace?.roles === true);
  const unique = [...new Set(failures)].sort();
  return { present: true, ready: unique.length === 0,
    binding: unique.length === 0 && maintenance && maintenanceOid ? { maintenance, maintenanceOid, app, appOid } : null, failures: unique };
}

export async function inspectRoutineIdentityOwnership(tx: Query, names?: RoutineIdentityOwnershipNames): Promise<boolean> {
  return (await inspectRoutineIdentityOwnershipCatalog(tx, names)).ready;
}

/** Caller-owned real App LOGIN transaction only. The independent shared gate
 * stays held through the business commit. It grants no authority and performs
 * no DDL, repair, data mutation or provider/ownership verification. */
async function requireRoutineIdentityOwnership(tx: Query, allowAbsent: boolean): Promise<boolean> {
  try {
    if (Object.hasOwn(tx, '$client')) throw Error('Routine identity ownership requires a caller-owned transaction');
    const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock_shared(731716,0) AS locked`);
    if (gate?.locked !== true) throw Error('Routine identity ownership maintenance is busy');
    const catalog = await inspectRoutineIdentityOwnershipCatalog(tx), binding = catalog.binding;
    if (allowAbsent && !catalog.present) return false;
    if (!catalog.ready || !binding?.app || !binding.appOid) throw Error('Routine identity ownership catalog or ACL is absent or drifted');
    const [identity] = await tx.execute(sql`SELECT current_user=session_user AND current_user=${binding.app}::name
      AND r.oid=${binding.appOid}::oid AND (SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid())=r.oid
      AND current_setting('server_version_num')::integer/10000=16 AND current_setting('transaction_isolation')='read committed'
      AND current_setting('transaction_read_only')='off' AND current_setting('session_replication_role')='origin'
      AND current_schema()='public' AND to_regclass('wechat_user')=to_regclass('public.wechat_user')
      AND to_regclass('"user"')=to_regclass('public."user"')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
      AND r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
      AND pg_catalog.has_database_privilege(r.oid,current_database(),'CONNECT') AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE')
      AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
      AND pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT') AND pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT')
      AND NOT pg_catalog.has_table_privilege(r.oid,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION')
      AND NOT pg_catalog.has_function_privilege(r.oid,to_regprocedure('public.routine_identity_ownership_immutable_v1()'),'EXECUTE') AS ready
      FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_class c
      WHERE r.rolname=current_user AND c.oid=to_regclass('public.routine_identity_ownership')`);
    if (identity?.ready !== true) throw Error('Routine identity ownership runtime identity or privileges are unsafe');
    return true;
  } catch (cause) {
    throw Object.assign(new ServiceUnavailableException('小程序身份归属或运行权限尚未就绪'), { cause });
  }
}

/** Require an exact installed catalog and the actual commissioned App LOGIN.
 * The caller-owned shared gate is held through commit. No ownership facts are
 * authenticated by this storage check. */
export async function assertRoutineIdentityOwnershipReady(tx: Query): Promise<void> {
  await requireRoutineIdentityOwnership(tx, false);
}

/** True absence alone returns false. Any namespace fragment, catalog/ACL drift,
 * busy maintenance gate or wrong actual installed-runtime identity throws 503.
 * A false result is never authorization to infer or backfill legacy ownership. */
export async function assertRoutineIdentityOwnershipInstalledTx(tx: Query): Promise<boolean> {
  return requireRoutineIdentityOwnership(tx, true);
}
