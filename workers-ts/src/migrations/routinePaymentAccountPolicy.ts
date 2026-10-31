import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';
import { pricingIdentifier } from './checkoutPricingLockCatalog';

type Query = Pick<DbClient, 'execute'>;
export interface RoutinePaymentAccountPolicyNames { maintenance: string; app: string; admin: string }
export interface RoutinePaymentAccountPolicyCatalog {
  present: boolean; ready: boolean; failures: string[];
  binding: { maintenance: string; maintenanceOid: string; app: string | null; appOid: string | null;
    admin: string | null; adminOid: string | null } | null;
}
export const ROUTINE_PAYMENT_ACCOUNT_POLICY_GATE = [731717, 0] as const;
export const ROUTINE_PAYMENT_ACCOUNT_POLICY_RUNTIME_PRIVILEGES = {
  app: { routine_payment_account_policy: ['SELECT'], routine_payment_account_use: ['SELECT', 'INSERT'] },
  admin: { routine_payment_account_policy: [], routine_payment_account_use: [] },
} as const;
export const ROUTINE_PAYMENT_ACCOUNT_POLICY_IMMUTABLE_BODY = `BEGIN
  RAISE EXCEPTION 'Routine payment account records are immutable' USING ERRCODE='42501';
END`;

/** Storage only: no policy approval, credential resolution, historical adoption,
 * current-config fallback or activation is performed. The maintenance service
 * authenticates complete journal revisions; the App authenticates provider
 * capture and the durable use in the very same original-evidence transaction. */
export const ROUTINE_PAYMENT_ACCOUNT_POLICY_SQL = `
CREATE TABLE public.routine_payment_account_policy (
  record_id uuid NOT NULL,
  kind varchar(8) NOT NULL,
  subject_id varchar(128) NOT NULL,
  revision integer NOT NULL,
  payload jsonb NOT NULL,
  created_at bigint NOT NULL,
  signature varchar(64) NOT NULL,
  CONSTRAINT rpap_pk PRIMARY KEY(record_id),
  CONSTRAINT rpap_revision_uq UNIQUE(kind,subject_id,revision),
  CONSTRAINT rpap_kind_ck CHECK(kind IN ('account','query')),
  CONSTRAINT rpap_subject_ck CHECK(subject_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT rpap_revision_ck CHECK(revision > 0),
  CONSTRAINT rpap_payload_ck CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=16384),
  CONSTRAINT rpap_created_ck CHECK(created_at > 0),
  CONSTRAINT rpap_signature_ck CHECK(signature ~ '^[a-f0-9]{64}$')
);
CREATE TABLE public.routine_payment_account_use (
  use_id varchar(64) NOT NULL,
  evidence_id varchar(64) NOT NULL,
  payload jsonb NOT NULL,
  created_at bigint NOT NULL,
  signature varchar(64) NOT NULL,
  CONSTRAINT rpau_pk PRIMARY KEY(use_id),
  CONSTRAINT rpau_id_ck CHECK(use_id ~ '^[a-f0-9]{64}$'),
  CONSTRAINT rpau_evidence_ck CHECK(evidence_id ~ '^[a-f0-9]{64}$'),
  CONSTRAINT rpau_payload_ck CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=16384),
  CONSTRAINT rpau_created_ck CHECK(created_at > 0),
  CONSTRAINT rpau_signature_ck CHECK(signature ~ '^[a-f0-9]{64}$')
);
CREATE INDEX rpau_evidence_idx ON public.routine_payment_account_use(evidence_id,use_id);
CREATE FUNCTION public.routine_payment_account_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $rpa$${ROUTINE_PAYMENT_ACCOUNT_POLICY_IMMUTABLE_BODY}$rpa$;
CREATE TRIGGER rpap_immutable_rows BEFORE UPDATE OR DELETE ON public.routine_payment_account_policy
FOR EACH ROW EXECUTE FUNCTION public.routine_payment_account_immutable_v1();
CREATE TRIGGER rpap_immutable_truncate BEFORE TRUNCATE ON public.routine_payment_account_policy
FOR EACH STATEMENT EXECUTE FUNCTION public.routine_payment_account_immutable_v1();
CREATE TRIGGER rpau_immutable_rows BEFORE UPDATE OR DELETE ON public.routine_payment_account_use
FOR EACH ROW EXECUTE FUNCTION public.routine_payment_account_immutable_v1();
CREATE TRIGGER rpau_immutable_truncate BEFORE TRUNCATE ON public.routine_payment_account_use
FOR EACH STATEMENT EXECUTE FUNCTION public.routine_payment_account_immutable_v1();
REVOKE ALL ON TABLE public.routine_payment_account_policy,public.routine_payment_account_use FROM PUBLIC;
REVOKE ALL ON FUNCTION public.routine_payment_account_immutable_v1() FROM PUBLIC;
`;
export const ROUTINE_PAYMENT_ACCOUNT_POLICY_EXPECTED_COLUMNS = {
  routine_payment_account_policy: [[1,'record_id','uuid',true,null], [2,'kind','character varying(8)',true,'"default"'],
    [3,'subject_id','character varying(128)',true,'"default"'], [4,'revision','integer',true,null],
    [5,'payload','jsonb',true,null], [6,'created_at','bigint',true,null], [7,'signature','character varying(64)',true,'"default"']],
  routine_payment_account_use: [[1,'use_id','character varying(64)',true,'"default"'],
    [2,'evidence_id','character varying(64)',true,'"default"'], [3,'payload','jsonb',true,null],
    [4,'created_at','bigint',true,null], [5,'signature','character varying(64)',true,'"default"']],
};
export const ROUTINE_PAYMENT_ACCOUNT_POLICY_EXPECTED_CONSTRAINTS: Record<string, Record<string,string>> = {
  routine_payment_account_policy: {
    rpap_pk: 'PRIMARY KEY (record_id)', rpap_revision_uq: 'UNIQUE (kind, subject_id, revision)',
    rpap_kind_ck: "CHECK (((kind)::text = ANY ((ARRAY['account'::character varying, 'query'::character varying])::text[])))",
    rpap_subject_ck: "CHECK (((subject_id)::text ~ '^[A-Za-z0-9._:-]{1,128}$'::text))",
    rpap_revision_ck: 'CHECK ((revision > 0))',
    rpap_payload_ck: "CHECK (((jsonb_typeof(payload) = 'object'::text) AND (octet_length((payload)::text) <= 16384)))",
    rpap_created_ck: 'CHECK ((created_at > 0))', rpap_signature_ck: "CHECK (((signature)::text ~ '^[a-f0-9]{64}$'::text))",
  },
  routine_payment_account_use: {
    rpau_pk: 'PRIMARY KEY (use_id)', rpau_id_ck: "CHECK (((use_id)::text ~ '^[a-f0-9]{64}$'::text))",
    rpau_evidence_ck: "CHECK (((evidence_id)::text ~ '^[a-f0-9]{64}$'::text))",
    rpau_payload_ck: "CHECK (((jsonb_typeof(payload) = 'object'::text) AND (octet_length((payload)::text) <= 16384)))",
    rpau_created_ck: 'CHECK ((created_at > 0))', rpau_signature_ck: "CHECK (((signature)::text ~ '^[a-f0-9]{64}$'::text))",
  },
};
const specs = [
  { table:'routine_payment_account_policy', prefix:'rpap', columns:7, checks:6, constraints:8, insert:false,
    indexes:{ rpap_pk:'CREATE UNIQUE INDEX rpap_pk ON public.routine_payment_account_policy USING btree (record_id)',
      rpap_revision_uq:'CREATE UNIQUE INDEX rpap_revision_uq ON public.routine_payment_account_policy USING btree (kind, subject_id, revision)' },
    indexShape:`(ic.relname='rpap_pk' AND i.indisprimary AND i.indisunique AND i.indkey::text='1' AND i.indoption::text='0'
      AND i.indclass::text=up.oid::text AND i.indcollation::text='0') OR
      (ic.relname='rpap_revision_uq' AND NOT i.indisprimary AND i.indisunique AND i.indkey::text='2 3 4' AND i.indoption::text='0 0 0'
      AND i.indclass::text=op.oid::text||' '||op.oid::text||' '||ip.oid::text AND i.indcollation::text=dc.oid::text||' '||dc.oid::text||' 0')` },
  { table:'routine_payment_account_use', prefix:'rpau', columns:5, checks:5, constraints:6, insert:true,
    indexes:{ rpau_pk:'CREATE UNIQUE INDEX rpau_pk ON public.routine_payment_account_use USING btree (use_id)',
      rpau_evidence_idx:'CREATE INDEX rpau_evidence_idx ON public.routine_payment_account_use USING btree (evidence_id, use_id)' },
    indexShape:`(ic.relname='rpau_pk' AND i.indisprimary AND i.indisunique AND i.indkey::text='1' AND i.indoption::text='0'
      AND i.indclass::text=op.oid::text AND i.indcollation::text=dc.oid::text) OR
      (ic.relname='rpau_evidence_idx' AND NOT i.indisprimary AND NOT i.indisunique AND i.indkey::text='2 1' AND i.indoption::text='0 0'
      AND i.indclass::text=op.oid::text||' '||op.oid::text AND i.indcollation::text=dc.oid::text||' '||dc.oid::text)` },
] as const;
const same = (a:unknown,b:unknown) => JSON.stringify(a)===JSON.stringify(b);

/** Pure catalog inspection: no advisory gate, row DML or policy/material read.
 * Both owner-only tables or both precisely commissioned tables are accepted;
 * mixed ownership/grants, partial namespace, peer grants and drift are not. */
export async function inspectRoutinePaymentAccountPolicyCatalog(tx:Query,
  declaredNames?:RoutinePaymentAccountPolicyNames):Promise<RoutinePaymentAccountPolicyCatalog> {
  const names=declaredNames?{maintenance:declaredNames.maintenance,app:declaredNames.app,admin:declaredNames.admin}:undefined;
  if(names) {
    try { [names.maintenance,names.app,names.admin].forEach(pricingIdentifier);
      if(new Set(Object.values(names)).size!==3) throw Error('Distinct identities required'); }
    catch { return {present:true,ready:false,binding:null,failures:['binding']}; }
  }
  const [inventory]=await tx.execute<{present:boolean;namespace:boolean}>(sql`SELECT
    EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND
      (starts_with(relname,'routine_payment_account') OR starts_with(relname,'rpap_') OR starts_with(relname,'rpau_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND
      (starts_with(proname,'routine_payment_account') OR starts_with(proname,'rpap_') OR starts_with(proname,'rpau_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace AND
      (starts_with(typname,'routine_payment_account') OR starts_with(typname,'_routine_payment_account')
      OR starts_with(typname,'rpap_') OR starts_with(typname,'_rpap_') OR starts_with(typname,'rpau_') OR starts_with(typname,'_rpau_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE connamespace='public'::regnamespace AND
      (starts_with(conname,'routine_payment_account') OR starts_with(conname,'rpap_') OR starts_with(conname,'rpau_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE starts_with(tgname,'routine_payment_account')
      OR starts_with(tgname,'rpap_') OR starts_with(tgname,'rpau_')) AS present,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
      AND (starts_with(relname,'routine_payment_account') OR starts_with(relname,'rpap_') OR starts_with(relname,'rpau_'))
      AND relname NOT IN ('routine_payment_account_policy','routine_payment_account_use','rpap_pk','rpap_revision_uq','rpau_pk','rpau_evidence_idx'))
    AND (SELECT count(*)=1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
      AND (starts_with(proname,'routine_payment_account') OR starts_with(proname,'rpap_') OR starts_with(proname,'rpau_')))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE connamespace='public'::regnamespace
      AND (starts_with(conname,'routine_payment_account') OR starts_with(conname,'rpap_') OR starts_with(conname,'rpau_'))
      AND conrelid IS DISTINCT FROM to_regclass('public.routine_payment_account_policy')
      AND conrelid IS DISTINCT FROM to_regclass('public.routine_payment_account_use'))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE
      (starts_with(tgname,'routine_payment_account') OR starts_with(tgname,'rpap_') OR starts_with(tgname,'rpau_'))
      AND tgrelid IS DISTINCT FROM to_regclass('public.routine_payment_account_policy')
      AND tgrelid IS DISTINCT FROM to_regclass('public.routine_payment_account_use')) AS namespace`);
  if(!inventory || typeof inventory.present!=='boolean') return {present:true,ready:false,binding:null,failures:['inventory']};
  if(!inventory.present) return {present:false,ready:false,binding:null,failures:[]};
  const failures:string[]=[];
  const check=(key:string,value:boolean)=>{if(!value)failures.push(key);};
  check('namespace',inventory.namespace===true);
  const bindings:Array<{maintenance:string;maintenanceOid:string;app:string|null;appOid:string|null}>=[];
  for(const spec of specs) {
    const [row]=await tx.execute<Record<string,unknown>>(sql`SELECT
      pg_catalog.pg_get_userbyid(c.relowner) AS maintenance,c.relowner::text AS maintenance_oid,
      current_setting('server_version_num')::integer/10000=16
      AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND c.relnatts=${spec.columns} AND c.relchecks=${spec.checks} AND c.reloptions IS NULL AND c.relreplident='d' AND c.reltablespace=0
      AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid=c.relowner AND r.rolsuper AND r.rolcanlogin
        AND (${names?.maintenance??null}::text IS NULL OR r.rolname=${names?.maintenance??null}::text))
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
      (SELECT count(*)=${spec.constraints} AND bool_and(convalidated AND NOT condeferrable AND NOT condeferred
        AND conislocal AND coninhcount=0 AND conparentid=0 AND connamespace='public'::regnamespace)
        FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype IN ('p','u','c')) AS constraint_count,
      (SELECT jsonb_object_agg(conname,pg_get_constraintdef(oid,false)) FROM pg_catalog.pg_constraint
        WHERE conrelid=c.oid AND contype IN ('p','u','c')) AS constraints,
      (SELECT jsonb_object_agg(ic.relname,pg_get_indexdef(ic.oid)) FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid) AS definitions,
      (SELECT count(*)=2 AND bool_and(i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
        AND NOT i.indisexclusion AND NOT i.indisclustered AND NOT i.indisreplident AND NOT i.indnullsnotdistinct
        AND i.indexprs IS NULL AND i.indpred IS NULL AND i.indnatts=i.indnkeyatts
        AND ic.relkind='i' AND ic.relpersistence='p' AND ic.reloptions IS NULL AND ic.reltablespace=0
        AND ic.relowner=c.relowner AND ic.relnamespace=c.relnamespace AND ic.relacl IS NULL
        AND ic.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree') AND (${sql.raw(spec.indexShape)}))
        FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
        CROSS JOIN pg_catalog.pg_collation dc CROSS JOIN pg_catalog.pg_opclass op CROSS JOIN pg_catalog.pg_opclass ip CROSS JOIN pg_catalog.pg_opclass up
        WHERE i.indrelid=c.oid AND dc.collname='default' AND dc.collnamespace='pg_catalog'::regnamespace
          AND op.opcname='text_ops' AND op.opcnamespace='pg_catalog'::regnamespace
          AND op.opcmethod=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')
          AND ip.opcname='int4_ops' AND ip.opcnamespace='pg_catalog'::regnamespace AND ip.opcmethod=op.opcmethod
          AND up.opcname='uuid_ops' AND up.opcnamespace='pg_catalog'::regnamespace AND up.opcmethod=op.opcmethod) AS indexes,
      (SELECT count(*)=2 AND bool_and(NOT t.tgisinternal AND t.tgenabled='O' AND t.tgnargs=0 AND t.tgqual IS NULL
        AND t.tgconstraint=0 AND t.tgfoid=f.oid AND t.tgattr::text='' AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND ((t.tgname=${spec.prefix+'_immutable_rows'} AND t.tgtype=27)
          OR (t.tgname=${spec.prefix+'_immutable_truncate'} AND t.tgtype=34))) FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid) AS triggers,
      f.proowner=c.relowner AND f.prosrc=${ROUTINE_PAYMENT_ACCOUNT_POLICY_IMMUTABLE_BODY}
      AND f.prorettype='pg_catalog.trigger'::regtype AND f.pronargs=0 AND f.proargtypes::text=''
      AND NOT f.prosecdef AND NOT f.proleakproof AND f.provolatile='v' AND f.prokind='f'
      AND f.proconfig=ARRAY['search_path=pg_catalog'] AND NOT f.proisstrict AND NOT f.proretset AND f.proparallel='u'
      AND f.procost=100 AND f.prorows=0 AND f.prosupport=0 AND f.provariadic=0 AND f.pronargdefaults=0
      AND f.proargdefaults IS NULL AND f.proallargtypes IS NULL AND f.proargmodes IS NULL AND f.proargnames IS NULL
      AND f.probin IS NULL AND f.prosqlbody IS NULL AND f.protrftypes IS NULL
      AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql' AND lanpltrusted)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgfoid=f.oid
        AND tgrelid IS DISTINCT FROM to_regclass('public.routine_payment_account_policy')
        AND tgrelid IS DISTINCT FROM to_regclass('public.routine_payment_account_use'))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend WHERE classid='pg_catalog.pg_proc'::regclass AND objid=f.oid AND deptype='e')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a
        WHERE a.grantee<>f.proowner OR a.grantor<>f.proowner) AS function,
      NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee WHERE a.grantee<>c.relowner
        AND (a.grantee=0 OR a.grantor<>c.relowner OR a.is_grantable OR
          a.privilege_type NOT IN ${sql.raw(spec.insert?"('SELECT','INSERT')":"('SELECT')")}
          OR NOT r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid))) AS acl_safe,
      COALESCE((SELECT jsonb_agg(jsonb_build_array(r.rolname,r.oid::text,a.privilege_type,a.is_grantable)
        ORDER BY r.rolname COLLATE "C",a.privilege_type COLLATE "C")
        FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee WHERE a.grantee<>c.relowner),'[]'::jsonb) AS grants
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_proc f ON f.oid=to_regprocedure('public.routine_payment_account_immutable_v1()')
      WHERE c.oid=to_regclass(${`public.${spec.table}`})`);
    if(!row) { check(spec.table+':catalog',false); continue; }
    for(const key of ['safe','constraint_count','indexes','triggers','function','acl_safe']) check(spec.table+':'+key,row[key]===true);
    check(spec.table+':columns',same(row.columns,ROUTINE_PAYMENT_ACCOUNT_POLICY_EXPECTED_COLUMNS[spec.table]));
    const equalMap=(actual:unknown,expected:Record<string,string>)=>!!actual && typeof actual==='object'
      && Object.keys(actual).length===Object.keys(expected).length && Object.entries(expected).every(([key,value])=>(actual as Record<string,unknown>)[key]===value);
    check(spec.table+':constraints',equalMap(row.constraints,ROUTINE_PAYMENT_ACCOUNT_POLICY_EXPECTED_CONSTRAINTS[spec.table]));
    check(spec.table+':definitions',equalMap(row.definitions,spec.indexes));
    const grants=row.grants as Array<[string,string,string,boolean]>|null;
    let app:string|null=null,appOid:string|null=null;
    if(Array.isArray(grants) && grants.length===(spec.insert?2:1)
      && grants.every(g=>Array.isArray(g) && g.length===4 && g[0]===grants[0][0] && g[1]===grants[0][1] && !g[3])
      && grants.map(g=>g[2]).join(',')===(spec.insert?'INSERT,SELECT':'SELECT')) {app=grants[0][0];appOid=grants[0][1];}
    else check(spec.table+':acl',Array.isArray(grants) && grants.length===0);
    const maintenance=typeof row.maintenance==='string'?row.maintenance:null,maintenanceOid=typeof row.maintenance_oid==='string'?row.maintenance_oid:null;
    check(spec.table+':binding',maintenance!==null && maintenanceOid!==null && app!==maintenance
      && (!names || maintenance===names.maintenance && app===names.app));
    if(maintenance && maintenanceOid) bindings.push({maintenance,maintenanceOid,app,appOid});
  }
  check('joint_binding',bindings.length===2 && same(bindings[0],bindings[1]));
  const binding=bindings[0];
  if(!binding) return {present:true,ready:false,binding:null,failures:[...new Set(failures)].sort()};
  const {maintenanceOid,app}=binding;
  const [namespace]=await tx.execute<{safe:boolean;roles:boolean;admin_oid:string|null}>(sql`SELECT
    (SELECT count(*)=4 AND bool_and(t.typowner=${maintenanceOid}::oid AND t.typacl IS NULL AND
      ((t.typname IN ('routine_payment_account_policy','routine_payment_account_use') AND t.typtype='c'
        AND t.typrelid=to_regclass('public.'||t.typname) AND t.oid=(SELECT reltype FROM pg_catalog.pg_class WHERE oid=t.typrelid)
        AND t.typarray=to_regtype('public._'||t.typname))
      OR (t.typname IN ('_routine_payment_account_policy','_routine_payment_account_use') AND t.typtype='b'
        AND t.typelem=to_regtype('public.'||substr(t.typname,2)) AND t.oid=(SELECT typarray FROM pg_catalog.pg_type WHERE oid=t.typelem))))
      FROM pg_catalog.pg_type t WHERE t.typnamespace='public'::regnamespace
      AND (starts_with(t.typname,'routine_payment_account') OR starts_with(t.typname,'_routine_payment_account')
        OR starts_with(t.typname,'rpap_') OR starts_with(t.typname,'_rpap_') OR starts_with(t.typname,'rpau_') OR starts_with(t.typname,'_rpau_')))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
      WHERE (d.defaclrole=${maintenanceOid}::oid AND d.defaclnamespace IN (0,'public'::regnamespace)
        AND d.defaclobjtype IN ('r','f','S') AND a.grantee<>d.defaclrole)
      OR a.grantee IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (${app},${names?.admin??null}))
      OR (a.grantee=0 AND d.defaclobjtype IN ('r','S'))) AS safe,
    (SELECT count(*)=${names?2:app?1:0} AND COALESCE(bool_and(r.rolcanlogin
      AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
      AND pg_catalog.has_database_privilege(r.oid,current_database(),'CONNECT') AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE')
      AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')),true)
      FROM pg_catalog.pg_roles r WHERE r.rolname IN (${app},${names?.admin??null})) AS roles,
    (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=${names?.admin??null}) AS admin_oid`);
  check('types_defaults',namespace?.safe===true);check('runtime_roles',namespace?.roles===true);
  const unique=[...new Set(failures)].sort();
  return {present:true,ready:unique.length===0,failures:unique,
    binding:unique.length===0?{...binding,admin:names?.admin??null,adminOid:namespace?.admin_oid??null}:null};
}

async function requireRuntime(tx:Query,allowAbsent:boolean,gate:boolean):Promise<boolean> {
  try {
    if(Object.hasOwn(tx,'$client')) throw Error('Caller-owned transaction required');
    await tx.execute(sql`SELECT
      set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
      set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
      set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
    if(gate) {
      const [lock]=await tx.execute(sql`SELECT pg_try_advisory_xact_lock_shared(731717,0) AS locked`);
      if(lock?.locked!==true) throw Error('Account maintenance is busy');
    }
    const catalog=await inspectRoutinePaymentAccountPolicyCatalog(tx),binding=catalog.binding;
    if(allowAbsent && !catalog.present) return false;
    if(!catalog.ready || !binding?.app || !binding.appOid) throw Error('Account catalog is not ready');
    const [identity]=await tx.execute(sql`SELECT current_user=session_user AND current_user=${binding.app}::name
      AND r.oid=${binding.appOid}::oid AND (SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid())=r.oid
      AND current_setting('server_version_num')::integer/10000=16 AND current_setting('transaction_isolation')='read committed'
      AND current_setting('transaction_read_only')='off' AND current_setting('session_replication_role')='origin'
      AND current_schema()='public'
      AND to_regclass('routine_payment_account_policy')=to_regclass('public.routine_payment_account_policy')
      AND to_regclass('routine_payment_account_use')=to_regclass('public.routine_payment_account_use')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
      AND r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
      AND pg_catalog.has_database_privilege(r.oid,current_database(),'CONNECT') AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE')
      AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
      AND NOT pg_catalog.has_function_privilege(r.oid,to_regprocedure('public.routine_payment_account_immutable_v1()'),'EXECUTE') AS ready
      FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
    if(identity?.ready!==true) throw Error('Unsafe actual runtime identity');
    return true;
  } catch { throw new ServiceUnavailableException('小程序付款账号策略或运行权限尚未就绪'); }
}
/** Fresh provider authorization only: acquire before physical/order locks. */
export async function assertRoutinePaymentAccountPolicyInstalledTx(tx:Query):Promise<boolean> {
  return requireRuntime(tx,true,true);
}
export async function assertRoutinePaymentAccountPolicyReady(tx:Query):Promise<void> {
  await requireRuntime(tx,false,true);
}
/** No advisory acquisition, no active/current policy read. Only for immutable
 * durable-use verification after an existing order lock, never fresh provider
 * authorization. Complete absence is false; partial/drift/wrong role is 503. */
export async function assertRoutinePaymentAccountPolicyReadInTx(tx:Query):Promise<boolean> {
  return requireRuntime(tx,true,false);
}
