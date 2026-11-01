import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRoutineOriginalPaymentEvidenceCatalog } from './routineOriginalPaymentEvidence';
import { inspectRoutinePaymentAccountPolicyCatalog } from './routinePaymentAccountPolicy';

type Query = Pick<DbClient, 'execute'>;
export interface RoutineShippingNames { maintenance: string; app: string; admin?: string }
export interface RoutineShippingCatalog {
  present: boolean; ready: boolean; failures: string[];
  binding: { maintenance: string; maintenanceOid: string; app: string | null; appOid: string | null;
    admin: string | null; adminOid: string | null } | null;
}
export const ROUTINE_SHIPPING_GATE = [731719, 0] as const;
export const ROUTINE_SHIPPING_RUNTIME_PRIVILEGES = {
  app: { routine_shipping_account_policy: ['SELECT'], routine_shipping_dispatch: ['SELECT','INSERT'], routine_shipping_provider_evidence: ['SELECT','INSERT'] },
  admin: { routine_shipping_account_policy: [], routine_shipping_dispatch: [], routine_shipping_provider_evidence: [] },
} as const;
export const ROUTINE_SHIPPING_IMMUTABLE_BODY = `BEGIN
  RAISE EXCEPTION 'Routine shipping records are immutable' USING ERRCODE='42501';
END`;
/** Storage only. JSON/signatures are authenticated by purpose-specific services;
 * a TLS shipping response is not an RSA-verified original payment observation. */
export const ROUTINE_SHIPPING_SQL = `
CREATE TABLE public.routine_shipping_account_policy (
  record_id uuid NOT NULL,
  account_id varchar(64) NOT NULL,
  revision integer NOT NULL,
  payload jsonb NOT NULL,
  created_at bigint NOT NULL,
  signature varchar(64) NOT NULL,
  CONSTRAINT rshp_pk PRIMARY KEY(record_id),
  CONSTRAINT rshp_revision_uq UNIQUE(account_id,revision),
  CONSTRAINT rshp_account_ck CHECK(account_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  CONSTRAINT rshp_revision_ck CHECK(revision > 0),
  CONSTRAINT rshp_payload_ck CHECK(pg_catalog.jsonb_typeof(payload)='object' AND pg_catalog.octet_length(payload::text)<=16384),
  CONSTRAINT rshp_created_ck CHECK(created_at > 0),
  CONSTRAINT rshp_signature_ck CHECK(signature ~ '^[a-f0-9]{64}$')
);
CREATE TABLE public.routine_shipping_dispatch (
  dispatch_id uuid NOT NULL,
  delivery_id integer NOT NULL,
  source_key varchar(64) NOT NULL,
  payload jsonb NOT NULL,
  created_at bigint NOT NULL,
  signature varchar(64) NOT NULL,
  CONSTRAINT rshd_pk PRIMARY KEY(dispatch_id),
  CONSTRAINT rshd_delivery_uq UNIQUE(delivery_id),
  CONSTRAINT rshd_delivery_ck CHECK(delivery_id > 0),
  CONSTRAINT rshd_source_ck CHECK(source_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT rshd_payload_ck CHECK(pg_catalog.jsonb_typeof(payload)='object' AND pg_catalog.octet_length(payload::text)<=65536),
  CONSTRAINT rshd_created_ck CHECK(created_at > 0),
  CONSTRAINT rshd_signature_ck CHECK(signature ~ '^[a-f0-9]{64}$')
);
CREATE INDEX rshd_source_idx ON public.routine_shipping_dispatch(source_key,created_at,dispatch_id);
CREATE TABLE public.routine_shipping_provider_evidence (
  evidence_id varchar(64) NOT NULL,
  dispatch_id uuid NOT NULL,
  payload jsonb NOT NULL,
  created_at bigint NOT NULL,
  signature varchar(64) NOT NULL,
  CONSTRAINT rshe_pk PRIMARY KEY(evidence_id),
  CONSTRAINT rshe_id_ck CHECK(evidence_id ~ '^[a-f0-9]{64}$'),
  CONSTRAINT rshe_payload_ck CHECK(pg_catalog.jsonb_typeof(payload)='object' AND pg_catalog.octet_length(payload::text)<=65536),
  CONSTRAINT rshe_created_ck CHECK(created_at > 0),
  CONSTRAINT rshe_signature_ck CHECK(signature ~ '^[a-f0-9]{64}$')
);
CREATE INDEX rshe_dispatch_idx ON public.routine_shipping_provider_evidence(dispatch_id,evidence_id);
CREATE FUNCTION public.routine_shipping_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $rsh$${ROUTINE_SHIPPING_IMMUTABLE_BODY}$rsh$;
CREATE TRIGGER rshp_immutable_rows BEFORE UPDATE OR DELETE ON public.routine_shipping_account_policy
FOR EACH ROW EXECUTE FUNCTION public.routine_shipping_immutable_v1();
CREATE TRIGGER rshp_immutable_truncate BEFORE TRUNCATE ON public.routine_shipping_account_policy
FOR EACH STATEMENT EXECUTE FUNCTION public.routine_shipping_immutable_v1();
CREATE TRIGGER rshd_immutable_rows BEFORE UPDATE OR DELETE ON public.routine_shipping_dispatch
FOR EACH ROW EXECUTE FUNCTION public.routine_shipping_immutable_v1();
CREATE TRIGGER rshd_immutable_truncate BEFORE TRUNCATE ON public.routine_shipping_dispatch
FOR EACH STATEMENT EXECUTE FUNCTION public.routine_shipping_immutable_v1();
CREATE TRIGGER rshe_immutable_rows BEFORE UPDATE OR DELETE ON public.routine_shipping_provider_evidence
FOR EACH ROW EXECUTE FUNCTION public.routine_shipping_immutable_v1();
CREATE TRIGGER rshe_immutable_truncate BEFORE TRUNCATE ON public.routine_shipping_provider_evidence
FOR EACH STATEMENT EXECUTE FUNCTION public.routine_shipping_immutable_v1();
REVOKE ALL ON TABLE public.routine_shipping_account_policy,public.routine_shipping_dispatch,public.routine_shipping_provider_evidence FROM PUBLIC;
REVOKE ALL ON FUNCTION public.routine_shipping_immutable_v1() FROM PUBLIC;
`;
export const ROUTINE_SHIPPING_EXPECTED_COLUMNS = {
  routine_shipping_account_policy: [[1,'record_id','uuid',true,null],[2,'account_id','character varying(64)',true,'"default"'],
    [3,'revision','integer',true,null],[4,'payload','jsonb',true,null],[5,'created_at','bigint',true,null],[6,'signature','character varying(64)',true,'"default"']],
  routine_shipping_dispatch: [[1,'dispatch_id','uuid',true,null],[2,'delivery_id','integer',true,null],[3,'source_key','character varying(64)',true,'"default"'],
    [4,'payload','jsonb',true,null],[5,'created_at','bigint',true,null],[6,'signature','character varying(64)',true,'"default"']],
  routine_shipping_provider_evidence: [[1,'evidence_id','character varying(64)',true,'"default"'],[2,'dispatch_id','uuid',true,null],
    [3,'payload','jsonb',true,null],[4,'created_at','bigint',true,null],[5,'signature','character varying(64)',true,'"default"']],
};
export const ROUTINE_SHIPPING_EXPECTED_CONSTRAINTS: Record<string,Record<string,string>> = {
 routine_shipping_account_policy: {
  rshp_pk:'PRIMARY KEY (record_id)',rshp_revision_uq:'UNIQUE (account_id, revision)',
  rshp_account_ck:"CHECK (((account_id)::text ~ '^[A-Za-z0-9_-]{1,64}$'::text))",rshp_revision_ck:'CHECK ((revision > 0))',
  rshp_payload_ck:"CHECK (((jsonb_typeof(payload) = 'object'::text) AND (octet_length((payload)::text) <= 16384)))",
  rshp_created_ck:'CHECK ((created_at > 0))',rshp_signature_ck:"CHECK (((signature)::text ~ '^[a-f0-9]{64}$'::text))",
 },
 routine_shipping_dispatch: {
  rshd_pk:'PRIMARY KEY (dispatch_id)',rshd_delivery_uq:'UNIQUE (delivery_id)',rshd_delivery_ck:'CHECK ((delivery_id > 0))',
  rshd_source_ck:"CHECK (((source_key)::text ~ '^[a-f0-9]{64}$'::text))",
  rshd_payload_ck:"CHECK (((jsonb_typeof(payload) = 'object'::text) AND (octet_length((payload)::text) <= 65536)))",
  rshd_created_ck:'CHECK ((created_at > 0))',rshd_signature_ck:"CHECK (((signature)::text ~ '^[a-f0-9]{64}$'::text))",
 },
 routine_shipping_provider_evidence: {
  rshe_pk:'PRIMARY KEY (evidence_id)',rshe_id_ck:"CHECK (((evidence_id)::text ~ '^[a-f0-9]{64}$'::text))",
  rshe_payload_ck:"CHECK (((jsonb_typeof(payload) = 'object'::text) AND (octet_length((payload)::text) <= 65536)))",
  rshe_created_ck:'CHECK ((created_at > 0))',rshe_signature_ck:"CHECK (((signature)::text ~ '^[a-f0-9]{64}$'::text))",
 },
};
const specs = [
 {table:'routine_shipping_account_policy',prefix:'rshp',columns:6,checks:5,constraints:7,insert:false,
  indexes:{rshp_pk:'CREATE UNIQUE INDEX rshp_pk ON public.routine_shipping_account_policy USING btree (record_id)',
   rshp_revision_uq:'CREATE UNIQUE INDEX rshp_revision_uq ON public.routine_shipping_account_policy USING btree (account_id, revision)'},
  indexShape:`(ic.relname='rshp_pk' AND i.indisprimary AND i.indisunique AND i.indkey::text='1' AND i.indoption::text='0' AND i.indclass::text=up.oid::text AND i.indcollation::text='0') OR
   (ic.relname='rshp_revision_uq' AND NOT i.indisprimary AND i.indisunique AND i.indkey::text='2 3' AND i.indoption::text='0 0' AND i.indclass::text=op.oid::text||' '||ip.oid::text AND i.indcollation::text=dc.oid::text||' 0')`},
 {table:'routine_shipping_dispatch',prefix:'rshd',columns:6,checks:5,constraints:7,insert:true,
  indexes:{rshd_pk:'CREATE UNIQUE INDEX rshd_pk ON public.routine_shipping_dispatch USING btree (dispatch_id)',
   rshd_delivery_uq:'CREATE UNIQUE INDEX rshd_delivery_uq ON public.routine_shipping_dispatch USING btree (delivery_id)',
   rshd_source_idx:'CREATE INDEX rshd_source_idx ON public.routine_shipping_dispatch USING btree (source_key, created_at, dispatch_id)'},
  indexShape:`(ic.relname='rshd_pk' AND i.indisprimary AND i.indisunique AND i.indkey::text='1' AND i.indoption::text='0' AND i.indclass::text=up.oid::text AND i.indcollation::text='0') OR
   (ic.relname='rshd_delivery_uq' AND NOT i.indisprimary AND i.indisunique AND i.indkey::text='2' AND i.indoption::text='0' AND i.indclass::text=ip.oid::text AND i.indcollation::text='0') OR
   (ic.relname='rshd_source_idx' AND NOT i.indisprimary AND NOT i.indisunique AND i.indkey::text='3 5 1' AND i.indoption::text='0 0 0' AND i.indclass::text=op.oid::text||' '||bp.oid::text||' '||up.oid::text AND i.indcollation::text=dc.oid::text||' 0 0')`},
 {table:'routine_shipping_provider_evidence',prefix:'rshe',columns:5,checks:4,constraints:5,insert:true,
  indexes:{rshe_pk:'CREATE UNIQUE INDEX rshe_pk ON public.routine_shipping_provider_evidence USING btree (evidence_id)',
   rshe_dispatch_idx:'CREATE INDEX rshe_dispatch_idx ON public.routine_shipping_provider_evidence USING btree (dispatch_id, evidence_id)'},
  indexShape:`(ic.relname='rshe_pk' AND i.indisprimary AND i.indisunique AND i.indkey::text='1' AND i.indoption::text='0' AND i.indclass::text=op.oid::text AND i.indcollation::text=dc.oid::text) OR
   (ic.relname='rshe_dispatch_idx' AND NOT i.indisprimary AND NOT i.indisunique AND i.indkey::text='2 1' AND i.indoption::text='0 0' AND i.indclass::text=up.oid::text||' '||op.oid::text AND i.indcollation::text='0 '||dc.oid::text)`},
] as const;
const TABLES = specs.map(spec=>spec.table);
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);

/** Exact pure metadata inspection. The App is proved by two complete existing
 * source catalogs before new shipping ACLs are compared; no grantee supplies
 * identity. Owner-only is an installer intermediate, not runtime readiness. */
export async function inspectRoutineShippingCatalog(tx:Query,declaredNames?:RoutineShippingNames):Promise<RoutineShippingCatalog> {
 let names:RoutineShippingNames|undefined;
 try {
  if(declaredNames){names={maintenance:declaredNames.maintenance,app:declaredNames.app,...(declaredNames.admin===undefined?{}:{admin:declaredNames.admin})};
   const identities=Object.values(names);identities.forEach(pricingIdentifier);if(new Set(identities).size!==identities.length)throw Error();}
 }catch{return{present:true,ready:false,binding:null,failures:['binding']};}
 const objects=await tx.execute<{kind:string;name:string}>(sql`SELECT 'relation' AS kind,c.relname AS name FROM pg_catalog.pg_class c
   WHERE c.relnamespace='public'::regnamespace AND c.relname ~ '^(routine_shipping|rsh[pde]_)'
  UNION ALL SELECT 'function',p.proname FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname ~ '^(routine_shipping|rsh[pde]_)'
  UNION ALL SELECT 'type',t.typname FROM pg_catalog.pg_type t WHERE t.typnamespace='public'::regnamespace AND t.typname ~ '^(_?routine_shipping|_?rsh[pde]_)'
  UNION ALL SELECT 'constraint',k.conname FROM pg_catalog.pg_constraint k WHERE k.connamespace='public'::regnamespace AND k.conname ~ '^(routine_shipping|rsh[pde]_)'
  UNION ALL SELECT 'trigger',t.tgname FROM pg_catalog.pg_trigger t WHERE t.tgname ~ '^(routine_shipping|rsh[pde]_)'`);
 if(!objects.length)return{present:false,ready:false,binding:null,failures:[]};
 const failures:string[]=[],check=(key:string,value:boolean)=>{if(!value)failures.push(key);};
 const expectedObjects=[...TABLES.map(n=>'relation:'+n),...specs.flatMap(s=>Object.keys(s.indexes).map(n=>'relation:'+n)),
  'function:routine_shipping_immutable_v1',...TABLES.flatMap(n=>['type:'+n,'type:_'+n]),
  ...Object.values(ROUTINE_SHIPPING_EXPECTED_CONSTRAINTS).flatMap(c=>Object.keys(c).map(n=>'constraint:'+n)),
  ...specs.flatMap(s=>['trigger:'+s.prefix+'_immutable_rows','trigger:'+s.prefix+'_immutable_truncate'])].sort();
 check('namespace',same(objects.map(o=>o.kind+':'+o.name).sort(),expectedObjects));
 const sourceNames=names?.admin?{maintenance:names.maintenance,app:names.app,admin:names.admin}:undefined;
 const original=await inspectRoutineOriginalPaymentEvidenceCatalog(tx,sourceNames),account=await inspectRoutinePaymentAccountPolicyCatalog(tx,sourceNames);
 const source=original.binding;
 check('source_binding',original.ready&&account.ready&&!!source?.app&&!!source.appOid&&!!account.binding?.app
  &&source.maintenance===account.binding.maintenance&&source.maintenanceOid===account.binding.maintenanceOid
  &&source.app===account.binding.app&&source.appOid===account.binding.appOid
  &&(!names||source.maintenance===names.maintenance&&source.app===names.app));
 if(!source?.app||!source.appOid)return{present:true,ready:false,binding:null,failures:[...new Set(failures)].sort()};
 const bindings:Array<{maintenance:string;maintenanceOid:string;app:string|null;appOid:string|null}>=[];
  for(const spec of specs) {
    const [row]=await tx.execute<Record<string,unknown>>(sql`SELECT
      pg_catalog.pg_get_userbyid(c.relowner) AS maintenance,c.relowner::text AS maintenance_oid,
      pg_catalog.current_setting('server_version_num')::integer/10000=16
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
      (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(attnum,attname,pg_catalog.format_type(atttypid,atttypmod),attnotnull,
        CASE WHEN attcollation=0 THEN NULL ELSE attcollation::regcollation::text END) ORDER BY attnum)
        FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attnum>0) AS columns,
      (SELECT pg_catalog.count(*)=${spec.constraints} AND pg_catalog.bool_and(convalidated AND NOT condeferrable AND NOT condeferred
        AND conislocal AND coninhcount=0 AND conparentid=0 AND connamespace='public'::regnamespace)
        FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype IN ('p','u','c')) AS constraint_count,
      (SELECT pg_catalog.jsonb_object_agg(conname,pg_catalog.pg_get_constraintdef(oid,false)) FROM pg_catalog.pg_constraint
        WHERE conrelid=c.oid AND contype IN ('p','u','c')) AS constraints,
      (SELECT pg_catalog.jsonb_object_agg(ic.relname,pg_catalog.pg_get_indexdef(ic.oid)) FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid) AS definitions,
      (SELECT pg_catalog.count(*)=${Object.keys(spec.indexes).length} AND pg_catalog.bool_and(i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
        AND NOT i.indisexclusion AND NOT i.indisclustered AND NOT i.indisreplident AND NOT i.indnullsnotdistinct
        AND i.indexprs IS NULL AND i.indpred IS NULL AND i.indnatts=i.indnkeyatts
        AND ic.relkind='i' AND ic.relpersistence='p' AND ic.reloptions IS NULL AND ic.reltablespace=0
        AND ic.relowner=c.relowner AND ic.relnamespace=c.relnamespace AND ic.relacl IS NULL
        AND ic.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree') AND (${sql.raw(spec.indexShape)}))
        FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
        CROSS JOIN pg_catalog.pg_collation dc CROSS JOIN pg_catalog.pg_opclass op CROSS JOIN pg_catalog.pg_opclass ip CROSS JOIN pg_catalog.pg_opclass up CROSS JOIN pg_catalog.pg_opclass bp
        WHERE i.indrelid=c.oid AND dc.collname='default' AND dc.collnamespace='pg_catalog'::regnamespace
          AND op.opcname='text_ops' AND op.opcnamespace='pg_catalog'::regnamespace
          AND op.opcmethod=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')
          AND ip.opcname='int4_ops' AND ip.opcnamespace='pg_catalog'::regnamespace AND ip.opcmethod=op.opcmethod
          AND bp.opcname='int8_ops' AND bp.opcnamespace='pg_catalog'::regnamespace AND bp.opcmethod=op.opcmethod
          AND up.opcname='uuid_ops' AND up.opcnamespace='pg_catalog'::regnamespace AND up.opcmethod=op.opcmethod) AS indexes,
      (SELECT pg_catalog.count(*)=2 AND pg_catalog.bool_and(NOT t.tgisinternal AND t.tgenabled='O' AND t.tgnargs=0 AND t.tgqual IS NULL
        AND t.tgconstraint=0 AND t.tgfoid=f.oid AND t.tgattr::text='' AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND ((t.tgname=${spec.prefix+'_immutable_rows'} AND t.tgtype=27)
          OR (t.tgname=${spec.prefix+'_immutable_truncate'} AND t.tgtype=34))) FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid) AS triggers,
      f.proowner=c.relowner AND f.prosrc=${ROUTINE_SHIPPING_IMMUTABLE_BODY}
      AND f.prorettype='pg_catalog.trigger'::regtype AND f.pronargs=0 AND f.proargtypes::text=''
      AND NOT f.prosecdef AND NOT f.proleakproof AND f.provolatile='v' AND f.prokind='f'
      AND f.proconfig=ARRAY['search_path=pg_catalog'] AND NOT f.proisstrict AND NOT f.proretset AND f.proparallel='u'
      AND f.procost=100 AND f.prorows=0 AND f.prosupport=0 AND f.provariadic=0 AND f.pronargdefaults=0
      AND f.proargdefaults IS NULL AND f.proallargtypes IS NULL AND f.proargmodes IS NULL AND f.proargnames IS NULL
      AND f.probin IS NULL AND f.prosqlbody IS NULL AND f.protrftypes IS NULL
      AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql' AND lanpltrusted)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgfoid=f.oid
        AND tgrelid NOT IN (SELECT pg_catalog.to_regclass('public.'||n) FROM pg_catalog.jsonb_array_elements_text(${JSON.stringify(TABLES)}::jsonb) n))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend WHERE classid='pg_catalog.pg_proc'::regclass AND objid=f.oid AND deptype='e')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a
        WHERE a.grantee<>f.proowner OR a.grantor<>f.proowner) AS function,
      NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee WHERE a.grantee<>c.relowner
        AND (a.grantee=0 OR a.grantor<>c.relowner OR a.is_grantable OR
          a.privilege_type NOT IN ${sql.raw(spec.insert?"('SELECT','INSERT')":"('SELECT')")}
          OR NOT r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid))) AS acl_safe,
      COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(r.rolname,r.oid::text,a.privilege_type,a.is_grantable)
        ORDER BY r.rolname COLLATE "C",a.privilege_type COLLATE "C")
        FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee WHERE a.grantee<>c.relowner),'[]'::jsonb) AS grants
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_proc f ON f.oid=pg_catalog.to_regprocedure('public.routine_shipping_immutable_v1()')
      WHERE c.oid=pg_catalog.to_regclass(${`public.${spec.table}`})`);
    if(!row) { check(spec.table+':catalog',false); continue; }
    for(const key of ['safe','constraint_count','indexes','triggers','function','acl_safe']) check(spec.table+':'+key,row[key]===true);
    check(spec.table+':columns',same(row.columns,ROUTINE_SHIPPING_EXPECTED_COLUMNS[spec.table]));
    const equalMap=(actual:unknown,expected:Record<string,string>)=>!!actual && typeof actual==='object'
      && Object.keys(actual).length===Object.keys(expected).length && Object.entries(expected).every(([key,value])=>(actual as Record<string,unknown>)[key]===value);
    check(spec.table+':constraints',equalMap(row.constraints,ROUTINE_SHIPPING_EXPECTED_CONSTRAINTS[spec.table]));
    check(spec.table+':definitions',equalMap(row.definitions,spec.indexes));
    const grants=row.grants as Array<[string,string,string,boolean]>|null;
    const maintenance=typeof row.maintenance==='string'?row.maintenance:null,maintenanceOid=typeof row.maintenance_oid==='string'?row.maintenance_oid:null;
    const expected=(spec.insert?['INSERT','SELECT']:['SELECT']).map(privilege=>[source.app,source.appOid,privilege,false]);
    const commissioned=Array.isArray(grants)&&same(grants,expected),ownerOnly=Array.isArray(grants)&&grants.length===0;
    check(spec.table+':acl',commissioned||!names&&ownerOnly);
    check(spec.table+':binding',maintenance===source.maintenance&&maintenanceOid===source.maintenanceOid);
    if(maintenance&&maintenanceOid)bindings.push({maintenance,maintenanceOid,app:commissioned?source.app:null,appOid:commissioned?source.appOid:null});
  }
  check('joint_binding',bindings.length===3&&bindings.every(b=>same(b,bindings[0])));
  const binding=bindings[0];
  if(!binding)return{present:true,ready:false,binding:null,failures:[...new Set(failures)].sort()};
  const[namespace]=await tx.execute<{safe:boolean;roles:boolean;admin_oid:string|null}>(sql`SELECT
    (SELECT pg_catalog.count(*)=6 AND pg_catalog.bool_and(t.typowner=${source.maintenanceOid}::oid AND t.typacl IS NULL AND
      ((t.typname IN(SELECT pg_catalog.jsonb_array_elements_text(${JSON.stringify(TABLES)}::jsonb)) AND t.typtype='c'
        AND t.typrelid=pg_catalog.to_regclass('public.'||t.typname) AND t.oid=(SELECT reltype FROM pg_catalog.pg_class WHERE oid=t.typrelid)
        AND t.typarray=pg_catalog.to_regtype('public._'||t.typname))
       OR(t.typname IN(SELECT '_'||pg_catalog.jsonb_array_elements_text(${JSON.stringify(TABLES)}::jsonb)) AND t.typtype='b'
        AND t.typelem=pg_catalog.to_regtype('public.'||pg_catalog.substr(t.typname,2)) AND t.oid=(SELECT typarray FROM pg_catalog.pg_type WHERE oid=t.typelem))))
      FROM pg_catalog.pg_type t WHERE t.typnamespace='public'::regnamespace AND t.typname ~ '^(_?routine_shipping|_?rsh[pde]_)')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
      WHERE(d.defaclrole=${source.maintenanceOid}::oid AND d.defaclnamespace IN(0,'public'::regnamespace) AND d.defaclobjtype IN('r','f','S') AND a.grantee<>d.defaclrole)
       OR a.grantee IN(SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN(${source.app},${names?.admin??null}))
       OR(a.grantee=0 AND d.defaclobjtype IN('r','S'))) AS safe,
    (SELECT pg_catalog.count(*)=${names?.admin?2:1} AND pg_catalog.bool_and(r.rolcanlogin
      AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
      AND pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CONNECT') AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE')
      AND NOT pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM'))
      FROM pg_catalog.pg_roles r WHERE r.rolname IN(${source.app},${names?.admin??null})) AS roles,
    (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=${names?.admin??null}) AS admin_oid`);
  check('types_defaults',namespace?.safe===true);check('runtime_roles',namespace?.roles===true);
  const unique=[...new Set(failures)].sort();
  return{present:true,ready:unique.length===0,failures:unique,binding:unique.length?null:{...binding,admin:names?.admin??null,adminOid:namespace?.admin_oid??null}};
}

async function requireRuntime(tx:Query,gate:boolean):Promise<boolean> {
 try {
  if(Object.hasOwn(tx,'$client'))throw Error();
  await tx.execute(sql`SELECT
   pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
   pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
   pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  if(gate){const[g]=await tx.execute(sql`SELECT pg_catalog.pg_try_advisory_xact_lock_shared(731719,0) AS locked`);if(g?.locked!==true)throw Error();}
  const catalog=await inspectRoutineShippingCatalog(tx);
  let b=catalog.binding;
  if(!catalog.present){
   const original=await inspectRoutineOriginalPaymentEvidenceCatalog(tx),account=await inspectRoutinePaymentAccountPolicyCatalog(tx);
   const source=original.binding,a=account.binding;
   if(!original.ready||!account.ready||!source?.app||!source.appOid||!a?.app||!a.appOid||source.maintenanceOid!==a.maintenanceOid
    ||source.appOid!==a.appOid)throw Error();
   b={maintenance:source.maintenance,maintenanceOid:source.maintenanceOid,app:source.app,appOid:source.appOid,admin:null,adminOid:null};
  }
  const[identity]=await tx.execute<{ready:boolean}>(sql`SELECT current_user=session_user
   AND current_user=${b?.app??null}::name AND r.oid=${b?.appOid??null}::oid
   AND r.oid=(SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid())
   AND pg_catalog.current_setting('server_version_num')::integer/10000=16
   AND(${gate} AND pg_catalog.current_setting('transaction_isolation')='read committed' AND pg_catalog.current_setting('transaction_read_only')='off'
    OR ${!gate} AND((pg_catalog.current_setting('transaction_isolation')='read committed' AND pg_catalog.current_setting('transaction_read_only')='off')
      OR(pg_catalog.current_setting('transaction_isolation')='repeatable read' AND pg_catalog.current_setting('transaction_read_only')='on')))
   AND pg_catalog.current_setting('session_replication_role')='origin' AND pg_catalog.current_schema()='public'
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
   AND pg_catalog.to_regclass('routine_shipping_account_policy') IS NOT DISTINCT FROM pg_catalog.to_regclass('public.routine_shipping_account_policy')
   AND pg_catalog.to_regclass('routine_shipping_dispatch') IS NOT DISTINCT FROM pg_catalog.to_regclass('public.routine_shipping_dispatch')
   AND pg_catalog.to_regclass('routine_shipping_provider_evidence') IS NOT DISTINCT FROM pg_catalog.to_regclass('public.routine_shipping_provider_evidence')
   AND pg_catalog.to_regclass('routine_original_payment_evidence')=pg_catalog.to_regclass('public.routine_original_payment_evidence')
   AND pg_catalog.to_regclass('routine_payment_account_policy')=pg_catalog.to_regclass('public.routine_payment_account_policy')
   AND pg_catalog.to_regclass('routine_payment_account_use')=pg_catalog.to_regclass('public.routine_payment_account_use')
   AND r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
   AND NOT COALESCE(pg_catalog.has_function_privilege(r.oid,pg_catalog.to_regprocedure('public.routine_shipping_immutable_v1()'),'EXECUTE'),false) AS ready
   FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
  if(!b?.app||!b.appOid||identity?.ready!==true)throw Error();
  if(!catalog.present)return false;
  if(!catalog.ready)throw Error();return true;
 }catch{throw new ServiceUnavailableException('小程序原账号发货数据库协议或运行权限尚未就绪');}
}
/** Fresh provider authorization begins before business locks. */
export async function assertRoutineShippingReadyTx(tx:Query):Promise<boolean>{return requireRuntime(tx,true);}
/** Durable historical reads acquire no new advisory gate; RC/RW or RR/RO only. */
export async function assertRoutineShippingReadTx(tx:Query):Promise<boolean>{return requireRuntime(tx,false);}
