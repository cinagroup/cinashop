import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';
import { RECHARGE_REFUND_BINDING_VERSION, RECHARGE_REFUND_STORAGE_COMMENT, RECHARGE_REFUND_TABLES,
  RECHARGE_REFUND_VALID_BODY, RECHARGE_REFUND_GUARD_BODY, RECHARGE_REFUND_LOCK_SOURCE_BODY, RECHARGE_REFUND_STATE_UPDATE_COLUMNS,
  RECHARGE_REFUND_RUNTIME_TABLE_PRIVILEGES, type RechargeRefundNames, type RechargeRefundBinding,
  type RechargeRefundRuntimeRole } from './rechargeRefundContract';

const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'";
const list=(values:readonly string[])=>values.map(literal).join(',');
const tables=RECHARGE_REFUND_TABLES;
const functions=[{name:'recharge_refund_valid_v1',args:'25 3802',result:'boolean',language:'sql',volatility:'i',parallel:'s',security:false,body:RECHARGE_REFUND_VALID_BODY},
  {name:'recharge_refund_guard_v1',args:'',result:'trigger',language:'plpgsql',volatility:'v',parallel:'u',security:false,body:RECHARGE_REFUND_GUARD_BODY},
  {name:'recharge_refund_lock_source_v1',args:'23',result:'integer',language:'plpgsql',volatility:'v',parallel:'u',security:true,body:RECHARGE_REFUND_LOCK_SOURCE_BODY}];
const classNames=tables.flatMap(t=>[t.name,...t.indexes.map(i=>i.name)]).sort();
const typeNames=tables.flatMap(t=>[t.name,'_'+t.name]).sort();
const constraintNames=tables.flatMap(t=>[t.prefix+'_valid_ck',...t.constraints.map(c=>c.name)]).sort();
const triggerNames=tables.flatMap(t=>[t.prefix+'_guard_rows',t.prefix+'_guard_truncate']).sort();
const prefix=`(name LIKE 'recharge\\_refund\\_%' ESCAPE '\\' OR name LIKE 'rcro\\_%' ESCAPE '\\'
  OR name LIKE 'rcra\\_%' ESCAPE '\\' OR name LIKE 'rcrr\\_%' ESCAPE '\\' OR name LIKE 'rcrs\\_%' ESCAPE '\\')`;
const typePrefix=`(${prefix} OR name LIKE '\\_recharge\\_refund\\_%' ESCAPE '\\' OR name LIKE '\\_rcro\\_%' ESCAPE '\\'
 OR name LIKE '\\_rcra\\_%' ESCAPE '\\' OR name LIKE '\\_rcrr\\_%' ESCAPE '\\' OR name LIKE '\\_rcrs\\_%' ESCAPE '\\')`;
const expectedTables=tables.map(t=>({name:t.name,columns:t.columns.map(([name,type,required],i)=>[i+1,name,type,required,null,'','',type==='text'?'pg_catalog.default':null]),
 constraints:[...t.constraints.map(c=>({name:c.name,kind:c.kind,columns:c.columns,target:c.target?'public.'+c.target:null,
  references:c.references??[],definition:null,fk:c.kind==='f'?['s','a','a']:null})),
  {name:t.prefix+'_valid_ck',kind:'c',columns:t.columns.map(c=>c[0]),target:null,references:[],
   definition:`CHECK (recharge_refund_valid_v1('${t.name.replace('recharge_refund_','')}'::text, jsonb_build_array(${t.columns.map(c=>c[0]).join(', ')})))`,fk:null}]
  .sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0),
 indexes:t.indexes.map(i=>({name:i.name,columns:i.columns,unique:i.unique,primary:i.primary??false,
  predicate:i.predicate??null,constraint:i.constraint??null,keyCount:i.columns.length,attributeCount:i.columns.length,
  operators:i.columns.map(name=>{const type=t.columns.find(c=>c[0]===name)![1];return 'pg_catalog.'+({uuid:'uuid_ops',integer:'int4_ops',bigint:'int8_ops',text:'text_ops'} as Record<string,string>)[type];}),
  collations:i.columns.map(name=>t.columns.find(c=>c[0]===name)![1]==='text'?'pg_catalog.default':null),
  sortOptions:i.columns.map(()=>0)})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0),
 triggers:[{name:t.prefix+'_guard_rows',type:31},{name:t.prefix+'_guard_truncate',type:34}].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)}))
 .sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
const expectedFunctions=functions.map(f=>({name:f.name,args:f.args,result:f.result,language:f.language,
  volatility:f.volatility,parallel:f.parallel,security:f.security,body:f.body})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
const expectedShape={tables:expectedTables,functions:expectedFunctions,classes:classNames,types:typeNames,
  constraints:constraintNames,triggers:triggerNames};
const bindingKeys=['version','database','databaseOid','maintenance','maintenanceOid','app','appOid','admin','adminOid',
  'financial','financialOid','manager','managerOid'];
const roleKeys=['maintenance','app','admin','financial','manager'] as const;
const runtimeAcl:Array<[string,string,string,string,string]>=[];
for(const role of ['admin','app','financial'] as const) {
 for(const [table,privileges] of Object.entries(RECHARGE_REFUND_RUNTIME_TABLE_PRIVILEGES[role]))
  for(const privilege of privileges)runtimeAcl.push(['table',table,'',role,privilege]);
 for(const column of RECHARGE_REFUND_STATE_UPDATE_COLUMNS)runtimeAcl.push(['column','recharge_refund_state',column,role,'UPDATE']);
 for(const name of ['recharge_refund_valid_v1','recharge_refund_lock_source_v1'])
  runtimeAcl.push(['function',name,'',role,'EXECUTE']);
}
const aclValues=runtimeAcl.map(row=>'('+row.map(literal).join(',')+')').join(',\n');

/** One closed catalog observation shared by explicit SQL installation and TS.
 * Definition checks use exact deparsing plus the fixed helper dependency, not
 * whitespace/cast stripping or mutable migration-history rows. */
export const RECHARGE_REFUND_CATALOG_SQL = `
WITH names(name) AS (VALUES ${tables.map(t=>'('+literal(t.name)+')').join(',')}),
 tt AS (SELECT c.*,n.name FROM names n JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public.'||n.name)),
 ff AS (SELECT p.*,l.lanname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
  WHERE p.pronamespace='public'::regnamespace AND ${prefix.replaceAll('name LIKE','p.proname LIKE')}),
 source AS (SELECT jsonb_build_object('oid',c.oid::text,'rowTypeOid',c.reltype::text,'ownerOid',c.relowner::text,
  'acl',c.relacl::text,'comment',pg_catalog.obj_description(c.oid,'pg_class'),'attnum',a.attnum,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
  'notNull',a.attnotnull,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity::text,'generated',a.attgenerated::text,
  'columnAcl',a.attacl::text,'columnComment',pg_catalog.col_description(c.oid,a.attnum),
  'otherColumns',(SELECT jsonb_agg(jsonb_build_array(x.attnum,x.attname,pg_catalog.format_type(x.atttypid,x.atttypmod),x.attnotnull,
   pg_catalog.pg_get_expr(z.adbin,z.adrelid),x.attidentity::text,x.attgenerated::text,x.attacl::text,pg_catalog.col_description(c.oid,x.attnum)) ORDER BY x.attnum)
   FROM pg_catalog.pg_attribute x LEFT JOIN pg_catalog.pg_attrdef z ON z.adrelid=x.attrelid AND z.adnum=x.attnum
   WHERE x.attrelid=c.oid AND x.attnum>0 AND x.attname<>'refund_price'),
  'indexes',(SELECT jsonb_agg(jsonb_build_array(i.indexrelid::text,pg_catalog.pg_get_indexdef(i.indexrelid),pg_catalog.obj_description(i.indexrelid,'pg_class')) ORDER BY i.indexrelid)
   FROM pg_catalog.pg_index i WHERE i.indrelid=c.oid)) AS snapshot,
  c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
   AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
   AND a.attnotnull AND NOT a.attisdropped AND a.atttypid='numeric'::regtype AND a.attidentity='' AND a.attgenerated=''
   AND pg_catalog.format_type(a.atttypid,a.atttypmod) IN('numeric(10,2)','numeric(12,2)')
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid) AS safe,
  c.relowner AS owner_oid
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname='refund_price' AND a.attnum>0
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE c.oid=pg_catalog.to_regclass('public.user_recharge')),
 shape AS (SELECT jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',t.name,
  'columns',(SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull,
   pg_catalog.pg_get_expr(d.adbin,d.adrelid),a.attidentity::text,a.attgenerated::text,
   CASE WHEN a.attcollation=0 THEN NULL ELSE n.nspname||'.'||co.collname END) ORDER BY a.attnum)
   FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace n ON n.oid=co.collnamespace
   WHERE a.attrelid=t.oid AND a.attnum>0),
  'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'kind',k.contype::text,
   'columns',COALESCE((SELECT jsonb_agg(a.attname ORDER BY keys.n) FROM unnest(k.conkey) WITH ORDINALITY keys(id,n)
     JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=keys.id),'[]'::jsonb),
   'target',CASE WHEN k.contype='f' THEN (SELECT n.nspname||'.'||c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=k.confrelid) ELSE NULL END,
   'references',COALESCE((SELECT jsonb_agg(a.attname ORDER BY keys.n) FROM unnest(k.confkey) WITH ORDINALITY keys(id,n)
     JOIN pg_catalog.pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=keys.id),'[]'::jsonb),
   'definition',CASE WHEN k.contype='c' THEN replace(pg_catalog.pg_get_constraintdef(k.oid,false),'public.recharge_refund_valid_v1','recharge_refund_valid_v1') ELSE NULL END,
   'fk',CASE WHEN k.contype='f' THEN jsonb_build_array(k.confmatchtype::text,k.confupdtype::text,k.confdeltype::text) ELSE NULL END) ORDER BY k.conname COLLATE "C")
   FROM pg_catalog.pg_constraint k WHERE k.conrelid=t.oid),
  'indexes',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,
   'columns',(SELECT jsonb_agg(a.attname ORDER BY keys.n) FROM unnest(i.indkey::smallint[]) WITH ORDINALITY keys(id,n) LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=keys.id),
   'unique',i.indisunique,'primary',i.indisprimary,'predicate',pg_catalog.pg_get_expr(i.indpred,i.indrelid,false),
   'constraint',(SELECT k.conname FROM pg_catalog.pg_constraint k WHERE k.conindid=i.indexrelid AND k.contype IN('p','u')),
   'keyCount',i.indnkeyatts,'attributeCount',i.indnatts,
   'operators',(SELECT jsonb_agg(n.nspname||'.'||o.opcname ORDER BY keys.n) FROM unnest(i.indclass::oid[]) WITH ORDINALITY keys(id,n) JOIN pg_catalog.pg_opclass o ON o.oid=keys.id JOIN pg_catalog.pg_namespace n ON n.oid=o.opcnamespace),
   'collations',(SELECT jsonb_agg(CASE WHEN keys.id=0 THEN NULL ELSE n.nspname||'.'||co.collname END ORDER BY keys.n) FROM unnest(i.indcollation::oid[]) WITH ORDINALITY keys(id,n) LEFT JOIN pg_catalog.pg_collation co ON co.oid=keys.id LEFT JOIN pg_catalog.pg_namespace n ON n.oid=co.collnamespace),
   'sortOptions',(SELECT jsonb_agg(keys.id ORDER BY keys.n) FROM unnest(i.indoption::smallint[]) WITH ORDINALITY keys(id,n))) ORDER BY c.relname COLLATE "C")
   FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=t.oid),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('name',g.tgname,'type',g.tgtype) ORDER BY g.tgname COLLATE "C") FROM pg_catalog.pg_trigger g WHERE g.tgrelid=t.oid AND NOT g.tgisinternal)) ORDER BY t.name COLLATE "C") FROM tt t),
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'args',p.proargtypes::text,
  'result',pg_catalog.format_type(p.prorettype,NULL),'language',p.lanname,'volatility',p.provolatile::text,'parallel',p.proparallel::text,'security',p.prosecdef,'body',p.prosrc)
  ORDER BY p.proname COLLATE "C") FROM ff p),
 'classes',(SELECT jsonb_agg(name ORDER BY name COLLATE "C") FROM (SELECT c.relname::text AS name FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace) q WHERE ${prefix}),
 'types',(SELECT jsonb_agg(name ORDER BY name COLLATE "C") FROM (SELECT t.typname::text AS name FROM pg_catalog.pg_type t WHERE t.typnamespace='public'::regnamespace) q WHERE ${typePrefix}),
 'constraints',(SELECT jsonb_agg(name ORDER BY name COLLATE "C") FROM (SELECT c.conname::text AS name FROM pg_catalog.pg_constraint c WHERE c.connamespace='public'::regnamespace) q WHERE ${prefix}),
 'triggers',(SELECT jsonb_agg(name ORDER BY name COLLATE "C") FROM (SELECT g.tgname::text AS name FROM pg_catalog.pg_trigger g) q WHERE ${prefix})
 ) AS actual),
 owner_role AS (SELECT r.* FROM pg_catalog.pg_roles r JOIN source s ON s.owner_oid=r.oid),
 op_comment AS (SELECT pg_catalog.obj_description(pg_catalog.to_regclass('public.recharge_refund_operation'),'pg_class') AS value),
 binding AS (SELECT CASE WHEN value=${literal(RECHARGE_REFUND_STORAGE_COMMENT)} THEN NULL ELSE value::jsonb END AS value FROM op_comment),
 participants AS (SELECT k.role_key,b.value->>k.role_key AS name,b.value->>(k.role_key||'Oid') AS declared_oid,r.*
  FROM binding b CROSS JOIN (VALUES ${roleKeys.map(k=>'('+literal(k)+')').join(',')}) k(role_key)
  LEFT JOIN pg_catalog.pg_roles r ON r.rolname=b.value->>k.role_key),
 binding_valid AS (SELECT b.value IS NOT NULL AND jsonb_typeof(b.value)='object'
  AND b.value ?& ARRAY[${list(bindingKeys)}]::text[] AND b.value-ARRAY[${list(bindingKeys)}]::text[]='{}'::jsonb
  AND NOT EXISTS(SELECT 1 FROM jsonb_each(b.value) entry WHERE jsonb_typeof(entry.value)<>'string')
  AND b.value->>'version'=${literal(RECHARGE_REFUND_BINDING_VERSION)}
  AND b.value->>'database'=current_database() AND b.value->>'databaseOid'=(SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database())
  AND (SELECT count(*)=5 AND count(DISTINCT oid)=5 AND bool_and(oid::text=declared_oid AND rolcanlogin
    AND pg_catalog.has_schema_privilege(p.oid,'public','USAGE')
    AND pg_catalog.has_database_privilege(p.oid,current_database(),'CONNECT')
    AND CASE WHEN role_key='maintenance' THEN rolsuper AND oid=(SELECT owner_oid FROM source)
      ELSE NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
       AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid=p.oid OR m.member=p.oid)
       AND NOT pg_catalog.has_parameter_privilege(p.oid,'session_replication_role','SET')
       AND NOT pg_catalog.has_parameter_privilege(p.oid,'session_replication_role','ALTER SYSTEM')
       AND NOT pg_catalog.has_database_privilege(p.oid,current_database(),'CREATE')
       AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
         AND pg_catalog.has_schema_privilege(p.oid,n.oid,'CREATE'))
       AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d
         WHERE d.refclassid='pg_catalog.pg_authid'::regclass AND d.refobjid=p.oid AND d.deptype='o') END) FROM participants p) AS safe FROM binding b),
 actual_acl(scope,object_name,column_name,grantee,grantor,privilege,grantable) AS (
 SELECT 'table',t.name,''::text,a.grantee::text,a.grantor::text,a.privilege_type,a.is_grantable FROM tt t CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(t.relacl,pg_catalog.acldefault('r',t.relowner))) a
 UNION ALL SELECT 'column',t.name,c.attname::text,a.grantee::text,a.grantor::text,a.privilege_type,a.is_grantable FROM tt t JOIN pg_catalog.pg_attribute c ON c.attrelid=t.oid AND c.attnum>0 CROSS JOIN LATERAL pg_catalog.aclexplode(c.attacl) a
 UNION ALL SELECT 'function',f.proname::text,''::text,a.grantee::text,a.grantor::text,a.privilege_type,a.is_grantable FROM ff f CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a),
 owner_acl(scope,object_name,column_name,grantee,grantor,privilege,grantable) AS (
 SELECT 'table',t.name,''::text,t.relowner::text,t.relowner::text,p.privilege,false FROM tt t CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(privilege)
 UNION ALL SELECT 'function',f.proname::text,''::text,f.proowner::text,f.proowner::text,'EXECUTE',false FROM ff f),
 runtime_acl AS (SELECT x.scope,x.object_name,x.column_name,p.oid::text AS grantee,(SELECT owner_oid::text FROM source) AS grantor,x.privilege,false AS grantable
  FROM (VALUES ${aclValues}) x(scope,object_name,column_name,role_key,privilege) JOIN participants p ON p.role_key=x.role_key),
 acl AS (SELECT
  (SELECT jsonb_agg(to_jsonb(a) ORDER BY scope,object_name,column_name,grantee,grantor,privilege,grantable) FROM actual_acl a)=
   (SELECT jsonb_agg(to_jsonb(a) ORDER BY scope,object_name,column_name,grantee,grantor,privilege,grantable) FROM owner_acl a) AS owner_only,
  (SELECT jsonb_agg(to_jsonb(a) ORDER BY scope,object_name,column_name,grantee,grantor,privilege,grantable) FROM actual_acl a)=
   (SELECT jsonb_agg(to_jsonb(a) ORDER BY scope,object_name,column_name,grantee,grantor,privilege,grantable) FROM (SELECT * FROM owner_acl UNION ALL SELECT * FROM runtime_acl) a) AS commissioned),
 ri_constraints AS (SELECT k.* FROM pg_catalog.pg_constraint k WHERE k.contype='f' AND k.conrelid IN(SELECT oid FROM tt)),
 ri_protocol AS (SELECT k.oid AS constraint_oid,k.conindid AS index_oid,p.event_type,
  CASE WHEN p.referenced_side THEN k.confrelid ELSE k.conrelid END AS own_relation,
  CASE WHEN p.referenced_side THEN k.conrelid ELSE k.confrelid END AS other_relation,
  pg_catalog.to_regprocedure(pg_catalog.format('pg_catalog.%I()',p.function_name)) AS function_oid
  FROM ri_constraints k CROSS JOIN (VALUES (5,false,'RI_FKey_check_ins'),(17,false,'RI_FKey_check_upd'),
   (9,true,'RI_FKey_noaction_del'),(17,true,'RI_FKey_noaction_upd')) p(event_type,referenced_side,function_name)),
 structural AS (SELECT current_setting('server_version_num')::integer/10000=16 AND sh.actual=$rcr_shape$${JSON.stringify(expectedShape)}$rcr_shape$::jsonb
  AND (SELECT safe FROM source) AND (SELECT rolsuper AND rolcanlogin FROM owner_role)
  AND NOT EXISTS(SELECT 1 FROM tt t WHERE t.relowner<>(SELECT owner_oid FROM source) OR t.relkind<>'r' OR t.relpersistence<>'p'
    OR t.relispartition OR t.relrowsecurity OR t.relforcerowsecurity OR t.relreplident<>'d' OR t.reloptions IS NOT NULL OR t.reltype=0
    OR t.relam<>(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=t.oid OR inhparent=t.oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=t.oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=t.oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=t.oid AND d.deptype='e')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid=t.oid AND (NOT k.convalidated OR k.condeferrable OR k.condeferred OR NOT k.conislocal OR k.coninhcount<>0 OR k.conparentid<>0))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.confrelid=t.oid AND k.conrelid NOT IN(SELECT oid FROM tt))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_am m ON m.oid=c.relam WHERE i.indrelid=t.oid AND
      (NOT i.indisvalid OR NOT i.indisready OR NOT i.indislive OR NOT i.indimmediate OR i.indisexclusion OR i.indnullsnotdistinct OR i.indisreplident OR i.indexprs IS NOT NULL OR c.reloptions IS NOT NULL OR m.amname<>'btree'))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid=t.oid AND NOT g.tgisinternal AND
      (g.tgfoid IS DISTINCT FROM pg_catalog.to_regprocedure('public.recharge_refund_guard_v1()') OR g.tgenabled<>'O'
       OR g.tgnargs<>0 OR octet_length(g.tgargs)<>0 OR g.tgqual IS NOT NULL OR g.tgattr::text<>'' OR g.tgconstraint<>0
       OR g.tgdeferrable OR g.tginitdeferred OR g.tgoldtable IS NOT NULL OR g.tgnewtable IS NOT NULL)))
  -- Each canonical FK has four immediate builtin RI triggers. Constraint
  -- metadata alone does not prove enforcement when an internal trigger is off.
  AND (SELECT count(*) FROM ri_constraints)=${tables.reduce((count,t)=>count+t.constraints.filter(c=>c.kind==='f').length,0)}
  AND NOT EXISTS(SELECT 1 FROM ri_constraints k WHERE k.contypid<>0 OR NOT k.connoinherit
    OR k.confdelsetcols IS NOT NULL OR k.conexclop IS NOT NULL OR k.conbin IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i WHERE i.indexrelid=k.conindid AND i.indrelid=k.confrelid
      AND i.indisunique AND i.indkey::text=pg_catalog.array_to_string(k.confkey,' '))
    OR (SELECT count(*) FROM pg_catalog.pg_trigger g WHERE g.tgconstraint=k.oid)<>4)
  AND NOT EXISTS(SELECT 1 FROM ri_protocol p WHERE
    (SELECT count(*) FROM pg_catalog.pg_trigger g WHERE g.tgconstraint=p.constraint_oid
      AND g.tgrelid=p.own_relation AND g.tgconstrrelid=p.other_relation AND g.tgconstrindid=p.index_oid
      AND g.tgfoid=p.function_oid AND g.tgtype=p.event_type AND g.tgisinternal AND g.tgenabled='O'
      AND g.tgparentid=0 AND NOT g.tgdeferrable AND NOT g.tginitdeferred
      AND g.tgnargs=0 AND octet_length(g.tgargs)=0 AND g.tgattr::text='' AND g.tgqual IS NULL
      AND g.tgoldtable IS NULL AND g.tgnewtable IS NULL
      AND (SELECT count(*) FROM pg_catalog.pg_depend d WHERE d.classid='pg_trigger'::regclass AND d.objid=g.oid
        AND d.refclassid='pg_constraint'::regclass)=1
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_trigger'::regclass AND d.objid=g.oid
        AND d.objsubid=0 AND d.refclassid='pg_constraint'::regclass AND d.refobjid=p.constraint_oid
        AND d.refobjsubid=0 AND d.deptype='i'))<>1)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid IN(SELECT oid FROM tt) AND g.tgisinternal
    AND NOT EXISTS(SELECT 1 FROM ri_constraints k WHERE k.oid=g.tgconstraint))
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_depend d
    ON d.classid='pg_trigger'::regclass AND d.objid=g.oid AND d.refclassid='pg_constraint'::regclass
    WHERE g.tgrelid IN(SELECT oid FROM tt) AND (NOT g.tgisinternal OR d.refobjid<>g.tgconstraint
      OR d.deptype<>'i' OR d.objsubid<>0 OR d.refobjsubid<>0))
  AND NOT EXISTS(SELECT 1 FROM ff f WHERE f.proowner<>(SELECT owner_oid FROM source) OR f.prosecdef IS DISTINCT FROM (f.proname='recharge_refund_lock_source_v1') OR f.proleakproof OR f.proisstrict
    OR f.proretset OR f.prokind<>'f' OR f.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
    OR f.prosupport<>0 OR f.provariadic<>0 OR f.procost<>100 OR f.prorows<>0 OR f.probin IS NOT NULL OR f.prosqlbody IS NOT NULL
    OR f.protrftypes IS NOT NULL OR f.proargdefaults IS NOT NULL OR f.proallargtypes IS NOT NULL
    OR f.proargmodes IS NOT NULL OR f.proargnames IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=f.oid AND d.deptype='e'))
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k JOIN tt t ON t.oid=k.conrelid WHERE k.contype='c' AND NOT EXISTS(
    SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_constraint'::regclass AND d.objid=k.oid AND d.refclassid='pg_proc'::regclass
    AND d.refobjid=pg_catalog.to_regprocedure('public.recharge_refund_valid_v1(text,jsonb)')))
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k JOIN tt t ON t.oid=k.conrelid JOIN pg_catalog.pg_depend d
    ON d.classid='pg_constraint'::regclass AND d.objid=k.oid AND d.refclassid='pg_proc'::regclass
    WHERE k.contype='c' AND d.refobjid IS DISTINCT FROM pg_catalog.to_regprocedure('public.recharge_refund_valid_v1(text,jsonb)'))
  AS safe FROM shape sh)
SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND ${prefix.replaceAll('name LIKE','c.relname LIKE')})
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND ${prefix.replaceAll('name LIKE','p.proname LIKE')})
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_type t WHERE t.typnamespace='public'::regnamespace AND ${typePrefix.replaceAll('name LIKE','t.typname LIKE')})
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.connamespace='public'::regnamespace AND ${prefix.replaceAll('name LIKE','k.conname LIKE')})
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_trigger g WHERE ${prefix.replaceAll('name LIKE','g.tgname LIKE')}) AS present,
 COALESCE((SELECT safe FROM source),false) AS source_safe,(SELECT snapshot FROM source) AS source,
 COALESCE((SELECT safe FROM structural),false) AS structural,
 COALESCE((SELECT owner_only FROM acl),false) AS owner_only,
 COALESCE((SELECT safe FROM binding_valid),false) AS binding_safe,
 COALESCE((SELECT commissioned FROM acl),false) AS commissioned_acl,
 (SELECT value FROM binding) AS binding,
 (SELECT oid::text FROM owner_role) AS maintenance_oid,
 (SELECT rolname FROM owner_role) AS maintenance,
 COALESCE((SELECT value=${literal(RECHARGE_REFUND_STORAGE_COMMENT)} FROM op_comment),false) AS unbound
`;

type Query=Pick<DbClient,'execute'>;
export interface RechargeRefundCatalog {present:boolean;installed:boolean;commissioned:boolean;binding:RechargeRefundBinding|null;failures:string[]}
export async function inspectRechargeRefundCatalog(tx:Query,target?:RechargeRefundNames):Promise<RechargeRefundCatalog> {
 try {
  const rows=await tx.execute<Record<string,unknown>>(sql.raw(RECHARGE_REFUND_CATALOG_SQL));
  if(rows.length!==1)return{present:true,installed:false,commissioned:false,binding:null,failures:['catalog_rows']};
  const r=rows[0],source=r.source as Record<string,unknown>|null;
  const rawBinding=r.binding as Record<string,string>|null;
  const binding=r.binding_safe===true&&rawBinding?Object.freeze(Object.fromEntries(bindingKeys.filter(key=>key!=='version')
   .map(key=>[key,rawBinding[key]]))) as unknown as RechargeRefundBinding:null;
  const targetMatches=!target||(binding?roleKeys.every(key=>target[key]===binding[key]):r.unbound===true&&target.maintenance===r.maintenance);
  const installed=r.structural===true&&source?.type==='numeric(12,2)'&&(r.owner_only===true||r.binding_safe===true&&r.commissioned_acl===true)
   &&(r.unbound===true||r.binding_safe===true)&&targetMatches;
  const commissioned=installed&&!!binding&&r.commissioned_acl===true;
  return {present:r.present===true,installed,commissioned,binding,failures:installed?[]:[r.present===true?'catalog_or_binding_drift':'not_installed']};
 } catch {return{present:true,installed:false,commissioned:false,binding:null,failures:['catalog_unavailable']};}
}
export async function assertRechargeRefundRuntimeTx(tx:Query,role:RechargeRefundRuntimeRole,mode:'write'|'read'='write'):Promise<RechargeRefundBinding> {
 if(!['app','admin','financial'].includes(role)||!['read','write'].includes(mode)||Object.hasOwn(tx,'$client'))throw new ServiceUnavailableException('充值退款运行身份无效');
 const [gate]=await tx.execute<{held:boolean}>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock_shared(731729,0) AS held`);
 if(gate?.held!==true)throw new ServiceUnavailableException('充值退款维护期间暂不可用');
 const catalog=await inspectRechargeRefundCatalog(tx),b=catalog.binding;
 if(!catalog.commissioned||!b)throw new ServiceUnavailableException('充值退款数据库尚未显式授权或合同已漂移');
 const [identity]=await tx.execute<{name:string;oid:string;safe:boolean}>(sql`SELECT r.rolname AS name,r.oid::text AS oid,
  current_user=session_user AND current_setting('transaction_isolation')=${mode==='read'?'repeatable read':'read committed'}
  AND current_setting('transaction_read_only')=${mode==='read'?'on':'off'} AND current_setting('session_replication_role')='origin'
  AND pg_catalog.to_regclass('recharge_refund_operation')=pg_catalog.to_regclass('public.recharge_refund_operation')
  AND pg_catalog.to_regclass('recharge_refund_state')=pg_catalog.to_regclass('public.recharge_refund_state')
  AND pg_catalog.to_regclass('recharge_refund_attempt')=pg_catalog.to_regclass('public.recharge_refund_attempt')
  AND pg_catalog.to_regclass('recharge_refund_result')=pg_catalog.to_regclass('public.recharge_refund_result') AS safe
  FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
 if(identity?.safe!==true||identity.name!==b[role]||identity.oid!==b[(role+'Oid') as keyof RechargeRefundBinding])
  throw new ServiceUnavailableException('充值退款连接与独立运行身份不一致');
 return b;
}
