import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from './customerFinancialRuntimePlan';

type Query = Pick<DbClient,'execute'>;
export interface RoutineRefundNames { maintenance:string; app:string; admin:string }
export interface RoutineRefundCatalog {
  present:boolean; ready:boolean; failures:string[];
  binding:{maintenance:string;maintenanceOid:string;app:string|null;appOid:string|null;
    admin:string|null;adminOid:string|null;financial:string|null;financialOid:string|null}|null;
}
export const ROUTINE_REFUND_GATE = [731718,0] as const;
export const ROUTINE_REFUND_RUNTIME_PRIVILEGES = {
  app:{routine_refund_account_policy:['SELECT'],routine_refund_dispatch:['SELECT','INSERT'],routine_refund_provider_evidence:['SELECT','INSERT']},
  admin:{routine_refund_account_policy:[],routine_refund_dispatch:[],routine_refund_provider_evidence:[]},
} as const;
export const ROUTINE_REFUND_IMMUTABLE_BODY = `BEGIN
  RAISE EXCEPTION 'Routine refund records are immutable' USING ERRCODE='42501';
END`;
/** Storage foundation only. Installing it approves no account, sends no refund,
 * adopts no historical identity and changes no existing refund business row. */
export const ROUTINE_REFUND_SQL = `
CREATE TABLE public.routine_refund_account_policy (
 record_id uuid NOT NULL,account_id varchar(64) NOT NULL,revision integer NOT NULL,
 payload jsonb NOT NULL,created_at bigint NOT NULL,signature varchar(64) NOT NULL,
 CONSTRAINT rrap_pk PRIMARY KEY(record_id),
 CONSTRAINT rrap_revision_uq UNIQUE(account_id,revision),
 CONSTRAINT rrap_account_ck CHECK(account_id ~ '^[A-Za-z0-9_-]{1,64}$'),
 CONSTRAINT rrap_revision_ck CHECK(revision>0),
 CONSTRAINT rrap_payload_ck CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=16384),
 CONSTRAINT rrap_created_ck CHECK(created_at>0),
 CONSTRAINT rrap_signature_ck CHECK(signature ~ '^[a-f0-9]{64}$')
);
CREATE TABLE public.routine_refund_dispatch (
 dispatch_id varchar(64) NOT NULL,refund_id integer NOT NULL,out_refund_no varchar(64) NOT NULL,
 payload jsonb NOT NULL,created_at bigint NOT NULL,signature varchar(64) NOT NULL,
 CONSTRAINT rrd_pk PRIMARY KEY(dispatch_id),CONSTRAINT rrd_refund_uq UNIQUE(refund_id),CONSTRAINT rrd_number_uq UNIQUE(out_refund_no),
 CONSTRAINT rrd_id_ck CHECK(dispatch_id ~ '^[a-f0-9]{64}$'),CONSTRAINT rrd_refund_ck CHECK(refund_id>0),
 CONSTRAINT rrd_number_ck CHECK(out_refund_no='CNSR'||refund_id::text),
 CONSTRAINT rrd_payload_ck CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=16384),
 CONSTRAINT rrd_created_ck CHECK(created_at>0),CONSTRAINT rrd_signature_ck CHECK(signature ~ '^[a-f0-9]{64}$')
);
CREATE TABLE public.routine_refund_provider_evidence (
 evidence_id varchar(64) NOT NULL,dispatch_id varchar(64) NOT NULL,source varchar(16) NOT NULL,
 source_id varchar(128) NOT NULL,payload jsonb NOT NULL,created_at bigint NOT NULL,signature varchar(64) NOT NULL,
 CONSTRAINT rrpe_pk PRIMARY KEY(evidence_id),CONSTRAINT rrpe_source_uq UNIQUE(source,source_id),
 CONSTRAINT rrpe_id_ck CHECK(evidence_id ~ '^[a-f0-9]{64}$'),CONSTRAINT rrpe_dispatch_ck CHECK(dispatch_id ~ '^[a-f0-9]{64}$'),
 CONSTRAINT rrpe_source_ck CHECK(source IN ('request','query','callback')),
 CONSTRAINT rrpe_source_id_ck CHECK(source_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
 CONSTRAINT rrpe_payload_ck CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=16384),
 CONSTRAINT rrpe_created_ck CHECK(created_at>0),CONSTRAINT rrpe_signature_ck CHECK(signature ~ '^[a-f0-9]{64}$')
);
CREATE INDEX rrpe_dispatch_idx ON public.routine_refund_provider_evidence(dispatch_id,evidence_id);
CREATE FUNCTION public.routine_refund_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $rr$${ROUTINE_REFUND_IMMUTABLE_BODY}$rr$;
CREATE TRIGGER rrap_immutable_rows BEFORE UPDATE OR DELETE ON public.routine_refund_account_policy
FOR EACH ROW EXECUTE FUNCTION public.routine_refund_immutable_v1();
CREATE TRIGGER rrap_immutable_truncate BEFORE TRUNCATE ON public.routine_refund_account_policy
FOR EACH STATEMENT EXECUTE FUNCTION public.routine_refund_immutable_v1();
CREATE TRIGGER rrd_immutable_rows BEFORE UPDATE OR DELETE ON public.routine_refund_dispatch
FOR EACH ROW EXECUTE FUNCTION public.routine_refund_immutable_v1();
CREATE TRIGGER rrd_immutable_truncate BEFORE TRUNCATE ON public.routine_refund_dispatch
FOR EACH STATEMENT EXECUTE FUNCTION public.routine_refund_immutable_v1();
CREATE TRIGGER rrpe_immutable_rows BEFORE UPDATE OR DELETE ON public.routine_refund_provider_evidence
FOR EACH ROW EXECUTE FUNCTION public.routine_refund_immutable_v1();
CREATE TRIGGER rrpe_immutable_truncate BEFORE TRUNCATE ON public.routine_refund_provider_evidence
FOR EACH STATEMENT EXECUTE FUNCTION public.routine_refund_immutable_v1();
REVOKE ALL ON TABLE public.routine_refund_account_policy,public.routine_refund_dispatch,public.routine_refund_provider_evidence FROM PUBLIC;
REVOKE ALL ON FUNCTION public.routine_refund_immutable_v1() FROM PUBLIC;
`;
export const ROUTINE_REFUND_EXPECTED_COLUMNS:Record<string,unknown> = {
 routine_refund_account_policy:[[1,'record_id','uuid',true,null],[2,'account_id','character varying(64)',true,'"default"'],[3,'revision','integer',true,null],
  [4,'payload','jsonb',true,null],[5,'created_at','bigint',true,null],[6,'signature','character varying(64)',true,'"default"']],
 routine_refund_dispatch:[[1,'dispatch_id','character varying(64)',true,'"default"'],[2,'refund_id','integer',true,null],[3,'out_refund_no','character varying(64)',true,'"default"'],
  [4,'payload','jsonb',true,null],[5,'created_at','bigint',true,null],[6,'signature','character varying(64)',true,'"default"']],
 routine_refund_provider_evidence:[[1,'evidence_id','character varying(64)',true,'"default"'],[2,'dispatch_id','character varying(64)',true,'"default"'],
  [3,'source','character varying(16)',true,'"default"'],[4,'source_id','character varying(128)',true,'"default"'],[5,'payload','jsonb',true,null],
  [6,'created_at','bigint',true,null],[7,'signature','character varying(64)',true,'"default"']],
};
const payloadCheck = "CHECK (((jsonb_typeof(payload) = 'object'::text) AND (octet_length((payload)::text) <= 16384)))";
const hexCheck = (name:string) => `CHECK (((${name})::text ~ '^[a-f0-9]{64}$'::text))`;
export const ROUTINE_REFUND_EXPECTED_CONSTRAINTS:Record<string,Record<string,string>> = {
 routine_refund_account_policy:{rrap_pk:'PRIMARY KEY (record_id)',rrap_revision_uq:'UNIQUE (account_id, revision)',
  rrap_account_ck:"CHECK (((account_id)::text ~ '^[A-Za-z0-9_-]{1,64}$'::text))",rrap_revision_ck:'CHECK ((revision > 0))',
  rrap_payload_ck:payloadCheck,rrap_created_ck:'CHECK ((created_at > 0))',rrap_signature_ck:hexCheck('signature')},
 routine_refund_dispatch:{rrd_pk:'PRIMARY KEY (dispatch_id)',rrd_refund_uq:'UNIQUE (refund_id)',rrd_number_uq:'UNIQUE (out_refund_no)',
  rrd_id_ck:hexCheck('dispatch_id'),rrd_refund_ck:'CHECK ((refund_id > 0))',rrd_number_ck:"CHECK (((out_refund_no)::text = ('CNSR'::text || (refund_id)::text)))",
  rrd_payload_ck:payloadCheck,rrd_created_ck:'CHECK ((created_at > 0))',rrd_signature_ck:hexCheck('signature')},
 routine_refund_provider_evidence:{rrpe_pk:'PRIMARY KEY (evidence_id)',rrpe_source_uq:'UNIQUE (source, source_id)',
  rrpe_id_ck:hexCheck('evidence_id'),rrpe_dispatch_ck:hexCheck('dispatch_id'),
  rrpe_source_ck:"CHECK (((source)::text = ANY ((ARRAY['request'::character varying, 'query'::character varying, 'callback'::character varying])::text[])))",
  rrpe_source_id_ck:"CHECK (((source_id)::text ~ '^[A-Za-z0-9._:-]{1,128}$'::text))",rrpe_payload_ck:payloadCheck,
  rrpe_created_ck:'CHECK ((created_at > 0))',rrpe_signature_ck:hexCheck('signature')},
};
type IndexSpec={name:string;columns:string;keys:string;ops:string;collations:string;unique:boolean;primary:boolean};
const index=(name:string,columns:string,keys:string,ops:string,collations:string,unique=false,primary=false):IndexSpec =>
 ({name,columns,keys,ops,collations,unique,primary});
function spec(table:string,prefix:string,columns:number,checks:number,insert:boolean,indices:IndexSpec[]) {
 return {table,prefix,columns,checks,insert,constraints:Object.keys(ROUTINE_REFUND_EXPECTED_CONSTRAINTS[table]).length,
  indexes:Object.fromEntries(indices.map(i=>[i.name,`CREATE ${i.unique?'UNIQUE ':''}INDEX ${i.name} ON public.${table} USING btree (${i.columns})`])),
  indexShape:indices.map(i=>`(ic.relname='${i.name}' AND ${i.primary?'':'NOT '}i.indisprimary AND ${i.unique?'':'NOT '}i.indisunique
   AND i.indkey::text='${i.keys}' AND i.indoption::text='${i.keys.split(' ').map(()=>'0').join(' ')}'
   AND i.indclass::text=${i.ops} AND i.indcollation::text=${i.collations})`).join(' OR ')};
}
const specs = [
 spec('routine_refund_account_policy','rrap',6,5,false,[
  index('rrap_pk','record_id','1','up.oid::text',"'0'",true,true),
  index('rrap_revision_uq','account_id, revision','2 3',"op.oid::text||' '||ip.oid::text","dc.oid::text||' 0'",true)]),
 spec('routine_refund_dispatch','rrd',6,6,true,[
  index('rrd_pk','dispatch_id','1','op.oid::text','dc.oid::text',true,true),
  index('rrd_refund_uq','refund_id','2','ip.oid::text',"'0'",true),
  index('rrd_number_uq','out_refund_no','3','op.oid::text','dc.oid::text',true)]),
 spec('routine_refund_provider_evidence','rrpe',7,7,true,[
  index('rrpe_pk','evidence_id','1','op.oid::text','dc.oid::text',true,true),
  index('rrpe_source_uq','source, source_id','3 4',"op.oid::text||' '||op.oid::text","dc.oid::text||' '||dc.oid::text",true),
  index('rrpe_dispatch_idx','dispatch_id, evidence_id','2 1',"op.oid::text||' '||op.oid::text","dc.oid::text||' '||dc.oid::text")]),
];
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export async function inspectRoutineRefundCatalog(tx:Query,declaredNames?:RoutineRefundNames):Promise<RoutineRefundCatalog> {
 const names=declaredNames?{maintenance:declaredNames.maintenance,app:declaredNames.app,admin:declaredNames.admin}:undefined;
 if(names) {try {[names.maintenance,names.app,names.admin].forEach(pricingIdentifier);
  if(new Set(Object.values(names)).size!==3 || Object.values(names).includes(CUSTOMER_FINANCIAL_RUNTIME_ROLE))throw Error();}
  catch{return{present:true,ready:false,binding:null,failures:['binding']};}}
 const [inventory]=await tx.execute<{present:boolean;namespace:boolean}>(sql`SELECT
  EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND (pg_catalog.starts_with(relname,'routine_refund') OR pg_catalog.starts_with(relname,'rrap_') OR pg_catalog.starts_with(relname,'rrd_') OR pg_catalog.starts_with(relname,'rrpe_')))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND (pg_catalog.starts_with(proname,'routine_refund') OR pg_catalog.starts_with(proname,'rrap_') OR pg_catalog.starts_with(proname,'rrd_') OR pg_catalog.starts_with(proname,'rrpe_')))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace AND (pg_catalog.starts_with(typname,'routine_refund') OR pg_catalog.starts_with(typname,'_routine_refund') OR pg_catalog.starts_with(typname,'rrap_') OR pg_catalog.starts_with(typname,'_rrap_') OR pg_catalog.starts_with(typname,'rrd_') OR pg_catalog.starts_with(typname,'_rrd_') OR pg_catalog.starts_with(typname,'rrpe_') OR pg_catalog.starts_with(typname,'_rrpe_')))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE connamespace='public'::regnamespace AND (pg_catalog.starts_with(conname,'routine_refund') OR pg_catalog.starts_with(conname,'rrap_') OR pg_catalog.starts_with(conname,'rrd_') OR pg_catalog.starts_with(conname,'rrpe_')))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE pg_catalog.starts_with(tgname,'routine_refund') OR pg_catalog.starts_with(tgname,'rrap_') OR pg_catalog.starts_with(tgname,'rrd_') OR pg_catalog.starts_with(tgname,'rrpe_')) AS present,
  NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND (pg_catalog.starts_with(relname,'routine_refund') OR pg_catalog.starts_with(relname,'rrap_') OR pg_catalog.starts_with(relname,'rrd_') OR pg_catalog.starts_with(relname,'rrpe_'))
   AND relname NOT IN('routine_refund_account_policy','routine_refund_dispatch','routine_refund_provider_evidence','rrap_pk','rrap_revision_uq','rrd_pk','rrd_refund_uq','rrd_number_uq','rrpe_pk','rrpe_source_uq','rrpe_dispatch_idx'))
  AND (SELECT pg_catalog.count(*)=1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND (pg_catalog.starts_with(proname,'routine_refund') OR pg_catalog.starts_with(proname,'rrap_') OR pg_catalog.starts_with(proname,'rrd_') OR pg_catalog.starts_with(proname,'rrpe_')))
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE connamespace='public'::regnamespace AND (pg_catalog.starts_with(conname,'routine_refund') OR pg_catalog.starts_with(conname,'rrap_') OR pg_catalog.starts_with(conname,'rrd_') OR pg_catalog.starts_with(conname,'rrpe_'))
   AND conrelid NOT IN(SELECT oid FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND relname IN('routine_refund_account_policy','routine_refund_dispatch','routine_refund_provider_evidence')))
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE (pg_catalog.starts_with(tgname,'routine_refund') OR pg_catalog.starts_with(tgname,'rrap_') OR pg_catalog.starts_with(tgname,'rrd_') OR pg_catalog.starts_with(tgname,'rrpe_'))
   AND tgrelid NOT IN(SELECT oid FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND relname IN('routine_refund_account_policy','routine_refund_dispatch','routine_refund_provider_evidence'))) AS namespace`);
 if(!inventory || typeof inventory.present!=='boolean')return{present:true,ready:false,binding:null,failures:['inventory']};
 if(!inventory.present)return{present:false,ready:false,binding:null,failures:[]};
 const failures:string[]=[],check=(key:string,value:boolean)=>{if(!value)failures.push(key);};
 check('namespace',inventory.namespace===true);
 const bindings:Array<{maintenance:string;maintenanceOid:string;app:string|null;appOid:string|null;financial:string|null;financialOid:string|null}>=[];
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
        CROSS JOIN pg_catalog.pg_collation dc CROSS JOIN pg_catalog.pg_opclass op CROSS JOIN pg_catalog.pg_opclass ip CROSS JOIN pg_catalog.pg_opclass up
        WHERE i.indrelid=c.oid AND dc.collname='default' AND dc.collnamespace='pg_catalog'::regnamespace
          AND op.opcname='text_ops' AND op.opcnamespace='pg_catalog'::regnamespace
          AND op.opcmethod=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')
          AND ip.opcname='int4_ops' AND ip.opcnamespace='pg_catalog'::regnamespace AND ip.opcmethod=op.opcmethod
          AND up.opcname='uuid_ops' AND up.opcnamespace='pg_catalog'::regnamespace AND up.opcmethod=op.opcmethod) AS indexes,
      (SELECT pg_catalog.count(*)=2 AND pg_catalog.bool_and(NOT t.tgisinternal AND t.tgenabled='O' AND t.tgnargs=0 AND t.tgqual IS NULL
        AND t.tgconstraint=0 AND t.tgfoid=f.oid AND t.tgattr::text='' AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND ((t.tgname=${spec.prefix+'_immutable_rows'} AND t.tgtype=27)
          OR (t.tgname=${spec.prefix+'_immutable_truncate'} AND t.tgtype=34))) FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid) AS triggers,
      f.proowner=c.relowner AND f.prosrc=${ROUTINE_REFUND_IMMUTABLE_BODY}
      AND f.prorettype='pg_catalog.trigger'::regtype AND f.pronargs=0 AND f.proargtypes::text=''
      AND NOT f.prosecdef AND NOT f.proleakproof AND f.provolatile='v' AND f.prokind='f'
      AND f.proconfig=ARRAY['search_path=pg_catalog'] AND NOT f.proisstrict AND NOT f.proretset AND f.proparallel='u'
      AND f.procost=100 AND f.prorows=0 AND f.prosupport=0 AND f.provariadic=0 AND f.pronargdefaults=0
      AND f.proargdefaults IS NULL AND f.proallargtypes IS NULL AND f.proargmodes IS NULL AND f.proargnames IS NULL
      AND f.probin IS NULL AND f.prosqlbody IS NULL AND f.protrftypes IS NULL
      AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql' AND lanpltrusted)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgfoid=f.oid
        AND tgrelid IS DISTINCT FROM pg_catalog.to_regclass('public.routine_refund_account_policy')
        AND tgrelid IS DISTINCT FROM pg_catalog.to_regclass('public.routine_refund_dispatch')
        AND tgrelid IS DISTINCT FROM pg_catalog.to_regclass('public.routine_refund_provider_evidence'))
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
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_proc f ON f.oid=pg_catalog.to_regprocedure('public.routine_refund_immutable_v1()')
      WHERE c.oid=pg_catalog.to_regclass(${`public.${spec.table}`})`);
    if(!row) { check(spec.table+':catalog',false); continue; }
    for(const key of ['safe','constraint_count','indexes','triggers','function','acl_safe']) check(spec.table+':'+key,row[key]===true);
    check(spec.table+':columns',same(row.columns,ROUTINE_REFUND_EXPECTED_COLUMNS[spec.table]));
    const equalMap=(actual:unknown,expected:Record<string,string>)=>!!actual && typeof actual==='object'
      && Object.keys(actual).length===Object.keys(expected).length && Object.entries(expected).every(([key,value])=>(actual as Record<string,unknown>)[key]===value);
    check(spec.table+':constraints',equalMap(row.constraints,ROUTINE_REFUND_EXPECTED_CONSTRAINTS[spec.table]));
    check(spec.table+':definitions',equalMap(row.definitions,spec.indexes));
    const grants=row.grants as Array<[string,string,string,boolean]>|null;
    const financialRows=Array.isArray(grants)?grants.filter(g=>g[0]===CUSTOMER_FINANCIAL_RUNTIME_ROLE):[];
    const appRows=Array.isArray(grants)?grants.filter(g=>g[0]!==CUSTOMER_FINANCIAL_RUNTIME_ROLE):[];
    const valid=(rows:Array<[string,string,string,boolean]>)=>rows.length===(spec.insert?2:1)
      && rows.every(g=>Array.isArray(g)&&g.length===4&&g[0]===rows[0][0]&&g[1]===rows[0][1]&&!g[3])
      && rows.map(g=>g[2]).join(',')===(spec.insert?'INSERT,SELECT':'SELECT');
    let app:string|null=null,appOid:string|null=null,financial:string|null=null,financialOid:string|null=null;
    if(valid(appRows)){app=appRows[0][0];appOid=appRows[0][1];}
    else check(spec.table+':acl',Array.isArray(grants)&&grants.length===0);
    if(financialRows.length){check(spec.table+':financial_acl',!!app&&valid(financialRows));
      if(valid(financialRows)){financial=CUSTOMER_FINANCIAL_RUNTIME_ROLE;financialOid=financialRows[0][1];}}
    const maintenance=typeof row.maintenance==='string'?row.maintenance:null,maintenanceOid=typeof row.maintenance_oid==='string'?row.maintenance_oid:null;
    check(spec.table+':binding',!!maintenance&&!!maintenanceOid&&app!==maintenance&&(app===null||app!==financial)
      && (!names||maintenance===names.maintenance&&app===names.app));
    if(maintenance&&maintenanceOid)bindings.push({maintenance,maintenanceOid,app,appOid,financial,financialOid});
  }
  check('joint_binding',bindings.length===3&&bindings.every(b=>same(b,bindings[0])));
  const binding=bindings[0];
  if(!binding)return{present:true,ready:false,binding:null,failures:[...new Set(failures)].sort()};
  const {maintenanceOid,app,financial}=binding;
  const [namespace]=await tx.execute<{safe:boolean;roles:boolean;admin_oid:string|null}>(sql`SELECT
    (SELECT pg_catalog.count(*)=6 AND pg_catalog.bool_and(t.typowner=${maintenanceOid}::oid AND t.typacl IS NULL
      AND ((t.typname IN('routine_refund_account_policy','routine_refund_dispatch','routine_refund_provider_evidence') AND t.typtype='c'
        AND t.typrelid=pg_catalog.to_regclass('public.'||t.typname) AND t.oid=(SELECT reltype FROM pg_catalog.pg_class WHERE oid=t.typrelid)
        AND t.typarray=pg_catalog.to_regtype('public._'||t.typname))
      OR (t.typname IN('_routine_refund_account_policy','_routine_refund_dispatch','_routine_refund_provider_evidence') AND t.typtype='b'
        AND t.typelem=pg_catalog.to_regtype('public.'||substr(t.typname,2)) AND t.oid=(SELECT typarray FROM pg_catalog.pg_type WHERE oid=t.typelem))))
     FROM pg_catalog.pg_type t WHERE typnamespace='public'::regnamespace AND (pg_catalog.starts_with(typname,'routine_refund') OR pg_catalog.starts_with(typname,'_routine_refund')
       OR pg_catalog.starts_with(typname,'rrap_') OR pg_catalog.starts_with(typname,'_rrap_') OR pg_catalog.starts_with(typname,'rrd_') OR pg_catalog.starts_with(typname,'_rrd_') OR pg_catalog.starts_with(typname,'rrpe_') OR pg_catalog.starts_with(typname,'_rrpe_')))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
      WHERE (d.defaclrole=${maintenanceOid}::oid AND d.defaclnamespace IN(0,'public'::regnamespace) AND d.defaclobjtype IN('r','f','S') AND a.grantee<>d.defaclrole)
      OR a.grantee IN(SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN(${app},${financial},${names?.admin??null})) OR (a.grantee=0 AND d.defaclobjtype IN('r','S'))) AS safe,
    (SELECT pg_catalog.count(*)=${(names?2:app?1:0)+(financial?1:0)} AND COALESCE(pg_catalog.bool_and(r.rolcanlogin
      AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
      AND pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CONNECT') AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE')
      AND NOT pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')),true)
      FROM pg_catalog.pg_roles r WHERE rolname IN(${app},${financial},${names?.admin??null})) AS roles,
    (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=${names?.admin??null}) AS admin_oid`);
  check('types_defaults',namespace?.safe===true);check('runtime_roles',namespace?.roles===true);
  if(financial){const {inspectCustomerFinancialRoutineRefundSourceAcls}=await import('./customerFinancialRoutineRefund');
   check('financial_sources',!!app&&await inspectCustomerFinancialRoutineRefundSourceAcls(tx,{maintenance:binding.maintenance,app:app!}));}
  const unique=[...new Set(failures)].sort();
  return{present:true,ready:!unique.length,failures:unique,binding:unique.length?null:{...binding,admin:names?.admin??null,adminOid:namespace?.admin_oid??null}};
}
async function requireRuntime(tx:Query,allowAbsent:boolean,gate:boolean,role?:'app'|'financial',statusRead=false):Promise<boolean> {
 try {
  if(Object.hasOwn(tx,'$client') || role!==undefined&&role!=='app'&&role!=='financial')throw Error();
  await tx.execute(sql`SELECT pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
   pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
   pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  if(gate){const [lock]=await tx.execute(sql`SELECT pg_catalog.pg_try_advisory_xact_lock_shared(731718,0) AS locked`);if(lock?.locked!==true)throw Error();}
  const catalog=await inspectRoutineRefundCatalog(tx),b=catalog.binding;
  if(allowAbsent&&!catalog.present)return false;
  if(!catalog.ready||!b?.app||!b.appOid)throw Error();
  const [identity]=await tx.execute<{name:string;oid:string;ready:boolean}>(sql`SELECT r.rolname AS name,r.oid::text AS oid,
   current_user=session_user AND r.oid=(SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid())
   AND pg_catalog.current_setting('server_version_num')::integer/10000=16
   AND pg_catalog.current_setting('transaction_isolation')=${statusRead?'repeatable read':'read committed'}
   AND pg_catalog.current_setting('transaction_read_only')=${statusRead?'on':'off'} AND pg_catalog.current_setting('session_replication_role')='origin' AND pg_catalog.current_schema()='public'
   AND pg_catalog.to_regclass('routine_refund_account_policy')=pg_catalog.to_regclass('public.routine_refund_account_policy')
   AND pg_catalog.to_regclass('routine_refund_dispatch')=pg_catalog.to_regclass('public.routine_refund_dispatch')
   AND pg_catalog.to_regclass('routine_refund_provider_evidence')=pg_catalog.to_regclass('public.routine_refund_provider_evidence')
   AND (${b.financial}::text IS NULL OR (pg_catalog.to_regclass('routine_original_payment_evidence')=pg_catalog.to_regclass('public.routine_original_payment_evidence')
    AND pg_catalog.to_regclass('routine_payment_account_policy')=pg_catalog.to_regclass('public.routine_payment_account_policy')
    AND pg_catalog.to_regclass('routine_payment_account_use')=pg_catalog.to_regclass('public.routine_payment_account_use')))
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
   AND r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
   AND NOT pg_catalog.has_function_privilege(r.oid,pg_catalog.to_regprocedure('public.routine_refund_immutable_v1()'),'EXECUTE') AS ready
   FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
  const isApp=identity?.name===b.app&&identity.oid===b.appOid;
  const isFinancial=identity?.name===CUSTOMER_FINANCIAL_RUNTIME_ROLE&&b.financial===identity.name&&b.financialOid===identity.oid;
  if(identity?.ready!==true || role==='app'&&!isApp || role==='financial'&&!isFinancial || !isApp&&!isFinancial)throw Error();
  // Financial's source reads are commissioned as one complete explicit addon.
  if(b.financial){const {inspectCustomerFinancialRoutineRefundReaders}=await import('./customerFinancialRoutineRefund');
   if(!await inspectCustomerFinancialRoutineRefundReaders(tx,{maintenance:b.maintenance,app:b.app}))throw Error();
   const {inspectRoutineOriginalPaymentEvidenceCatalog}=await import('./routineOriginalPaymentEvidence');
   const {inspectRoutinePaymentAccountPolicyCatalog}=await import('./routinePaymentAccountPolicy');
   if(!(await inspectRoutineOriginalPaymentEvidenceCatalog(tx)).ready||!(await inspectRoutinePaymentAccountPolicyCatalog(tx)).ready)throw Error();}
  return true;
 }catch{throw new ServiceUnavailableException('小程序原账号退款数据库协议或运行权限尚未就绪');}
}
export async function assertRoutineRefundInstalledTx(tx:Query,role?:'app'|'financial'):Promise<boolean>{return requireRuntime(tx,true,true,role);}
export async function assertRoutineRefundReady(tx:Query,role?:'app'|'financial'):Promise<void>{await requireRuntime(tx,false,true,role);}
/** Historical immutable reads only; never fresh provider approval. No gate is acquired. */
export async function assertRoutineRefundReadInTx(tx:Query,role?:'app'|'financial'):Promise<boolean>{return requireRuntime(tx,true,false,role);}
/** Status projection only. This grants no fresh provider authority, takes no
 * maintenance gate and is deliberately unavailable in a writing transaction. */
export async function assertRoutineRefundStatusReadTx(tx:Query,role?:'app'|'financial'):Promise<boolean>{return requireRuntime(tx,true,false,role,true);}
