-- Explicit PG16 maintenance transaction; not an automatic startup migration.
BEGIN;

-- 0203 deliberately widens only user_recharge.refund_price numeric(10,2) to
-- numeric(12,2). Both scales are 2; the built-in numeric widening has no USING
-- expression and preserves every value. Existing owner/ACL/comments, relation
-- and column identity, other columns and indexes are compared under one lock.
SET LOCAL search_path TO pg_catalog,public,pg_temp;
SET LOCAL row_security TO off;
SET LOCAL standard_conforming_strings TO on;
SELECT set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),30000),30000)::text||'ms',true),
 set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000),1000)::text||'ms',true),
 set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true);
DO $recharge_refund_install$
DECLARE before_state record; after_state record; original_source jsonb;
 inspection_sql constant text := $recharge_refund_inspection$
WITH names(name) AS (VALUES ('recharge_refund_operation'),('recharge_refund_attempt'),('recharge_refund_result'),('recharge_refund_state')),
 tt AS (SELECT c.*,n.name FROM names n JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public.'||n.name)),
 ff AS (SELECT p.*,l.lanname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
  WHERE p.pronamespace='public'::regnamespace AND (p.proname LIKE 'recharge\_refund\_%' ESCAPE '\' OR p.proname LIKE 'rcro\_%' ESCAPE '\'
  OR p.proname LIKE 'rcra\_%' ESCAPE '\' OR p.proname LIKE 'rcrr\_%' ESCAPE '\' OR p.proname LIKE 'rcrs\_%' ESCAPE '\')),
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
 'classes',(SELECT jsonb_agg(name ORDER BY name COLLATE "C") FROM (SELECT c.relname::text AS name FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace) q WHERE (name LIKE 'recharge\_refund\_%' ESCAPE '\' OR name LIKE 'rcro\_%' ESCAPE '\'
  OR name LIKE 'rcra\_%' ESCAPE '\' OR name LIKE 'rcrr\_%' ESCAPE '\' OR name LIKE 'rcrs\_%' ESCAPE '\')),
 'types',(SELECT jsonb_agg(name ORDER BY name COLLATE "C") FROM (SELECT t.typname::text AS name FROM pg_catalog.pg_type t WHERE t.typnamespace='public'::regnamespace) q WHERE ((name LIKE 'recharge\_refund\_%' ESCAPE '\' OR name LIKE 'rcro\_%' ESCAPE '\'
  OR name LIKE 'rcra\_%' ESCAPE '\' OR name LIKE 'rcrr\_%' ESCAPE '\' OR name LIKE 'rcrs\_%' ESCAPE '\') OR name LIKE '\_recharge\_refund\_%' ESCAPE '\' OR name LIKE '\_rcro\_%' ESCAPE '\'
 OR name LIKE '\_rcra\_%' ESCAPE '\' OR name LIKE '\_rcrr\_%' ESCAPE '\' OR name LIKE '\_rcrs\_%' ESCAPE '\')),
 'constraints',(SELECT jsonb_agg(name ORDER BY name COLLATE "C") FROM (SELECT c.conname::text AS name FROM pg_catalog.pg_constraint c WHERE c.connamespace='public'::regnamespace) q WHERE (name LIKE 'recharge\_refund\_%' ESCAPE '\' OR name LIKE 'rcro\_%' ESCAPE '\'
  OR name LIKE 'rcra\_%' ESCAPE '\' OR name LIKE 'rcrr\_%' ESCAPE '\' OR name LIKE 'rcrs\_%' ESCAPE '\')),
 'triggers',(SELECT jsonb_agg(name ORDER BY name COLLATE "C") FROM (SELECT g.tgname::text AS name FROM pg_catalog.pg_trigger g) q WHERE (name LIKE 'recharge\_refund\_%' ESCAPE '\' OR name LIKE 'rcro\_%' ESCAPE '\'
  OR name LIKE 'rcra\_%' ESCAPE '\' OR name LIKE 'rcrr\_%' ESCAPE '\' OR name LIKE 'rcrs\_%' ESCAPE '\'))
 ) AS actual),
 owner_role AS (SELECT r.* FROM pg_catalog.pg_roles r JOIN source s ON s.owner_oid=r.oid),
 op_comment AS (SELECT pg_catalog.obj_description(pg_catalog.to_regclass('public.recharge_refund_operation'),'pg_class') AS value),
 binding AS (SELECT CASE WHEN value='recharge-refund-storage-v1' THEN NULL ELSE value::jsonb END AS value FROM op_comment),
 participants AS (SELECT k.role_key,b.value->>k.role_key AS name,b.value->>(k.role_key||'Oid') AS declared_oid,r.*
  FROM binding b CROSS JOIN (VALUES ('maintenance'),('app'),('admin'),('financial'),('manager')) k(role_key)
  LEFT JOIN pg_catalog.pg_roles r ON r.rolname=b.value->>k.role_key),
 binding_valid AS (SELECT b.value IS NOT NULL AND jsonb_typeof(b.value)='object'
  AND b.value ?& ARRAY['version','database','databaseOid','maintenance','maintenanceOid','app','appOid','admin','adminOid','financial','financialOid','manager','managerOid']::text[] AND b.value-ARRAY['version','database','databaseOid','maintenance','maintenanceOid','app','appOid','admin','adminOid','financial','financialOid','manager','managerOid']::text[]='{}'::jsonb
  AND NOT EXISTS(SELECT 1 FROM jsonb_each(b.value) entry WHERE jsonb_typeof(entry.value)<>'string')
  AND b.value->>'version'='recharge-refund-runtime-v1'
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
  FROM (VALUES ('table','recharge_refund_operation','','admin','SELECT'),
('table','recharge_refund_operation','','admin','INSERT'),
('table','recharge_refund_state','','admin','SELECT'),
('table','recharge_refund_state','','admin','INSERT'),
('table','recharge_refund_attempt','','admin','SELECT'),
('table','recharge_refund_attempt','','admin','INSERT'),
('table','recharge_refund_result','','admin','SELECT'),
('table','recharge_refund_result','','admin','INSERT'),
('column','recharge_refund_state','status','admin','UPDATE'),
('column','recharge_refund_state','wallet_state','admin','UPDATE'),
('column','recharge_refund_state','version','admin','UPDATE'),
('column','recharge_refund_state','lease_id','admin','UPDATE'),
('column','recharge_refund_state','lease_until','admin','UPDATE'),
('column','recharge_refund_state','provider_refund_id','admin','UPDATE'),
('column','recharge_refund_state','attempt_count','admin','UPDATE'),
('column','recharge_refund_state','next_query_at','admin','UPDATE'),
('column','recharge_refund_state','last_result_id','admin','UPDATE'),
('column','recharge_refund_state','updated_at','admin','UPDATE'),
('function','recharge_refund_valid_v1','','admin','EXECUTE'),
('function','recharge_refund_lock_source_v1','','admin','EXECUTE'),
('table','recharge_refund_operation','','app','SELECT'),
('table','recharge_refund_state','','app','SELECT'),
('table','recharge_refund_attempt','','app','SELECT'),
('table','recharge_refund_attempt','','app','INSERT'),
('table','recharge_refund_result','','app','SELECT'),
('table','recharge_refund_result','','app','INSERT'),
('column','recharge_refund_state','status','app','UPDATE'),
('column','recharge_refund_state','wallet_state','app','UPDATE'),
('column','recharge_refund_state','version','app','UPDATE'),
('column','recharge_refund_state','lease_id','app','UPDATE'),
('column','recharge_refund_state','lease_until','app','UPDATE'),
('column','recharge_refund_state','provider_refund_id','app','UPDATE'),
('column','recharge_refund_state','attempt_count','app','UPDATE'),
('column','recharge_refund_state','next_query_at','app','UPDATE'),
('column','recharge_refund_state','last_result_id','app','UPDATE'),
('column','recharge_refund_state','updated_at','app','UPDATE'),
('function','recharge_refund_valid_v1','','app','EXECUTE'),
('function','recharge_refund_lock_source_v1','','app','EXECUTE'),
('table','recharge_refund_operation','','financial','SELECT'),
('table','recharge_refund_state','','financial','SELECT'),
('table','recharge_refund_attempt','','financial','SELECT'),
('table','recharge_refund_attempt','','financial','INSERT'),
('table','recharge_refund_result','','financial','SELECT'),
('table','recharge_refund_result','','financial','INSERT'),
('column','recharge_refund_state','status','financial','UPDATE'),
('column','recharge_refund_state','wallet_state','financial','UPDATE'),
('column','recharge_refund_state','version','financial','UPDATE'),
('column','recharge_refund_state','lease_id','financial','UPDATE'),
('column','recharge_refund_state','lease_until','financial','UPDATE'),
('column','recharge_refund_state','provider_refund_id','financial','UPDATE'),
('column','recharge_refund_state','attempt_count','financial','UPDATE'),
('column','recharge_refund_state','next_query_at','financial','UPDATE'),
('column','recharge_refund_state','last_result_id','financial','UPDATE'),
('column','recharge_refund_state','updated_at','financial','UPDATE'),
('function','recharge_refund_valid_v1','','financial','EXECUTE'),
('function','recharge_refund_lock_source_v1','','financial','EXECUTE')) x(scope,object_name,column_name,role_key,privilege) JOIN participants p ON p.role_key=x.role_key),
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
 structural AS (SELECT current_setting('server_version_num')::integer/10000=16 AND sh.actual=$rcr_shape${"tables":[{"name":"recharge_refund_attempt","columns":[[1,"attempt_id","uuid",true,null,"","",null],[2,"operation_id","uuid",true,null,"","",null],[3,"ordinal","integer",true,null,"","",null],[4,"kind","text",true,null,"","","pg_catalog.default"],[5,"lease_id","uuid",true,null,"","",null],[6,"request_hash","text",true,null,"","","pg_catalog.default"],[7,"payload","jsonb",true,null,"","",null],[8,"created_at","bigint",true,null,"","",null],[9,"signature","text",true,null,"","","pg_catalog.default"]],"constraints":[{"name":"rcra_operation_fk","kind":"f","columns":["operation_id"],"target":"public.recharge_refund_operation","references":["operation_id"],"definition":null,"fk":["s","a","a"]},{"name":"rcra_ordinal_uq","kind":"u","columns":["operation_id","ordinal"],"target":null,"references":[],"definition":null,"fk":null},{"name":"rcra_pk","kind":"p","columns":["attempt_id"],"target":null,"references":[],"definition":null,"fk":null},{"name":"rcra_result_identity_uq","kind":"u","columns":["operation_id","attempt_id","kind"],"target":null,"references":[],"definition":null,"fk":null},{"name":"rcra_valid_ck","kind":"c","columns":["attempt_id","operation_id","ordinal","kind","lease_id","request_hash","payload","created_at","signature"],"target":null,"references":[],"definition":"CHECK (recharge_refund_valid_v1('attempt'::text, jsonb_build_array(attempt_id, operation_id, ordinal, kind, lease_id, request_hash, payload, created_at, signature)))","fk":null}],"indexes":[{"name":"rcra_ordinal_uq","columns":["operation_id","ordinal"],"unique":true,"primary":false,"predicate":null,"constraint":"rcra_ordinal_uq","keyCount":2,"attributeCount":2,"operators":["pg_catalog.uuid_ops","pg_catalog.int4_ops"],"collations":[null,null],"sortOptions":[0,0]},{"name":"rcra_pk","columns":["attempt_id"],"unique":true,"primary":true,"predicate":null,"constraint":"rcra_pk","keyCount":1,"attributeCount":1,"operators":["pg_catalog.uuid_ops"],"collations":[null],"sortOptions":[0]},{"name":"rcra_result_identity_uq","columns":["operation_id","attempt_id","kind"],"unique":true,"primary":false,"predicate":null,"constraint":"rcra_result_identity_uq","keyCount":3,"attributeCount":3,"operators":["pg_catalog.uuid_ops","pg_catalog.uuid_ops","pg_catalog.text_ops"],"collations":[null,null,"pg_catalog.default"],"sortOptions":[0,0,0]},{"name":"rcra_single_request_uq","columns":["operation_id"],"unique":true,"primary":false,"predicate":"(kind = 'request'::text)","constraint":null,"keyCount":1,"attributeCount":1,"operators":["pg_catalog.uuid_ops"],"collations":[null],"sortOptions":[0]}],"triggers":[{"name":"rcra_guard_rows","type":31},{"name":"rcra_guard_truncate","type":34}]},{"name":"recharge_refund_operation","columns":[[1,"operation_id","uuid",true,null,"","",null],[2,"admin_id","integer",true,null,"","",null],[3,"request_key","uuid",true,null,"","",null],[4,"request_hash","text",true,null,"","","pg_catalog.default"],[5,"recharge_id","integer",true,null,"","",null],[6,"buyer_uid","integer",false,null,"","",null],[7,"order_no","text",false,null,"","","pg_catalog.default"],[8,"provider","text",false,null,"","","pg_catalog.default"],[9,"payment_profile","text",false,null,"","","pg_catalog.default"],[10,"transaction_id","text",false,null,"","","pg_catalog.default"],[11,"payment_source","jsonb",false,null,"","",null],[12,"payment_signature","text",false,null,"","","pg_catalog.default"],[13,"principal_cents","bigint",false,null,"","",null],[14,"gift_cents","bigint",false,null,"","",null],[15,"reclaim_gift","boolean",false,null,"","",null],[16,"debit_cents","bigint",false,null,"","",null],[17,"wallet_before","bigint",false,null,"","",null],[18,"wallet_after","bigint",false,null,"","",null],[19,"admission","text",true,null,"","","pg_catalog.default"],[20,"out_refund_no","text",false,null,"","","pg_catalog.default"],[21,"created_at","bigint",true,null,"","",null],[22,"signature","text",true,null,"","","pg_catalog.default"]],"constraints":[{"name":"rcro_admin_key_uq","kind":"u","columns":["admin_id","request_key"],"target":null,"references":[],"definition":null,"fk":null},{"name":"rcro_number_uq","kind":"u","columns":["out_refund_no"],"target":null,"references":[],"definition":null,"fk":null},{"name":"rcro_pk","kind":"p","columns":["operation_id"],"target":null,"references":[],"definition":null,"fk":null},{"name":"rcro_state_identity_uq","kind":"u","columns":["operation_id","recharge_id","admission"],"target":null,"references":[],"definition":null,"fk":null},{"name":"rcro_valid_ck","kind":"c","columns":["operation_id","admin_id","request_key","request_hash","recharge_id","buyer_uid","order_no","provider","payment_profile","transaction_id","payment_source","payment_signature","principal_cents","gift_cents","reclaim_gift","debit_cents","wallet_before","wallet_after","admission","out_refund_no","created_at","signature"],"target":null,"references":[],"definition":"CHECK (recharge_refund_valid_v1('operation'::text, jsonb_build_array(operation_id, admin_id, request_key, request_hash, recharge_id, buyer_uid, order_no, provider, payment_profile, transaction_id, payment_source, payment_signature, principal_cents, gift_cents, reclaim_gift, debit_cents, wallet_before, wallet_after, admission, out_refund_no, created_at, signature)))","fk":null}],"indexes":[{"name":"rcro_admin_key_uq","columns":["admin_id","request_key"],"unique":true,"primary":false,"predicate":null,"constraint":"rcro_admin_key_uq","keyCount":2,"attributeCount":2,"operators":["pg_catalog.int4_ops","pg_catalog.uuid_ops"],"collations":[null,null],"sortOptions":[0,0]},{"name":"rcro_number_uq","columns":["out_refund_no"],"unique":true,"primary":false,"predicate":null,"constraint":"rcro_number_uq","keyCount":1,"attributeCount":1,"operators":["pg_catalog.text_ops"],"collations":["pg_catalog.default"],"sortOptions":[0]},{"name":"rcro_pk","columns":["operation_id"],"unique":true,"primary":true,"predicate":null,"constraint":"rcro_pk","keyCount":1,"attributeCount":1,"operators":["pg_catalog.uuid_ops"],"collations":[null],"sortOptions":[0]},{"name":"rcro_recharge_history","columns":["recharge_id","created_at","operation_id"],"unique":false,"primary":false,"predicate":null,"constraint":null,"keyCount":3,"attributeCount":3,"operators":["pg_catalog.int4_ops","pg_catalog.int8_ops","pg_catalog.uuid_ops"],"collations":[null,null,null],"sortOptions":[0,0,0]},{"name":"rcro_state_identity_uq","columns":["operation_id","recharge_id","admission"],"unique":true,"primary":false,"predicate":null,"constraint":"rcro_state_identity_uq","keyCount":3,"attributeCount":3,"operators":["pg_catalog.uuid_ops","pg_catalog.int4_ops","pg_catalog.text_ops"],"collations":[null,null,"pg_catalog.default"],"sortOptions":[0,0,0]}],"triggers":[{"name":"rcro_guard_rows","type":31},{"name":"rcro_guard_truncate","type":34}]},{"name":"recharge_refund_result","columns":[[1,"result_id","uuid",true,null,"","",null],[2,"operation_id","uuid",true,null,"","",null],[3,"attempt_id","uuid",false,null,"","",null],[4,"source","text",true,null,"","","pg_catalog.default"],[5,"source_id","text",true,null,"","","pg_catalog.default"],[6,"status","text",true,null,"","","pg_catalog.default"],[7,"evidence","jsonb",true,null,"","",null],[8,"signature","text",true,null,"","","pg_catalog.default"],[9,"created_at","bigint",true,null,"","",null],[10,"caused_by_result_id","uuid",false,null,"","",null]],"constraints":[{"name":"rcrr_attempt_fk","kind":"f","columns":["operation_id","attempt_id","source"],"target":"public.recharge_refund_attempt","references":["operation_id","attempt_id","kind"],"definition":null,"fk":["s","a","a"]},{"name":"rcrr_attempt_uq","kind":"u","columns":["attempt_id"],"target":null,"references":[],"definition":null,"fk":null},{"name":"rcrr_cause_fk","kind":"f","columns":["operation_id","caused_by_result_id"],"target":"public.recharge_refund_result","references":["operation_id","result_id"],"definition":null,"fk":["s","a","a"]},{"name":"rcrr_operation_fk","kind":"f","columns":["operation_id"],"target":"public.recharge_refund_operation","references":["operation_id"],"definition":null,"fk":["s","a","a"]},{"name":"rcrr_operation_result_uq","kind":"u","columns":["operation_id","result_id"],"target":null,"references":[],"definition":null,"fk":null},{"name":"rcrr_pk","kind":"p","columns":["result_id"],"target":null,"references":[],"definition":null,"fk":null},{"name":"rcrr_source_uq","kind":"u","columns":["source","source_id"],"target":null,"references":[],"definition":null,"fk":null},{"name":"rcrr_valid_ck","kind":"c","columns":["result_id","operation_id","attempt_id","source","source_id","status","evidence","signature","created_at","caused_by_result_id"],"target":null,"references":[],"definition":"CHECK (recharge_refund_valid_v1('result'::text, jsonb_build_array(result_id, operation_id, attempt_id, source, source_id, status, evidence, signature, created_at, caused_by_result_id)))","fk":null}],"indexes":[{"name":"rcrr_attempt_uq","columns":["attempt_id"],"unique":true,"primary":false,"predicate":null,"constraint":"rcrr_attempt_uq","keyCount":1,"attributeCount":1,"operators":["pg_catalog.uuid_ops"],"collations":[null],"sortOptions":[0]},{"name":"rcrr_operation_history","columns":["operation_id","created_at","result_id"],"unique":false,"primary":false,"predicate":null,"constraint":null,"keyCount":3,"attributeCount":3,"operators":["pg_catalog.uuid_ops","pg_catalog.int8_ops","pg_catalog.uuid_ops"],"collations":[null,null,null],"sortOptions":[0,0,0]},{"name":"rcrr_operation_result_uq","columns":["operation_id","result_id"],"unique":true,"primary":false,"predicate":null,"constraint":"rcrr_operation_result_uq","keyCount":2,"attributeCount":2,"operators":["pg_catalog.uuid_ops","pg_catalog.uuid_ops"],"collations":[null,null],"sortOptions":[0,0]},{"name":"rcrr_pk","columns":["result_id"],"unique":true,"primary":true,"predicate":null,"constraint":"rcrr_pk","keyCount":1,"attributeCount":1,"operators":["pg_catalog.uuid_ops"],"collations":[null],"sortOptions":[0]},{"name":"rcrr_source_uq","columns":["source","source_id"],"unique":true,"primary":false,"predicate":null,"constraint":"rcrr_source_uq","keyCount":2,"attributeCount":2,"operators":["pg_catalog.text_ops","pg_catalog.text_ops"],"collations":["pg_catalog.default","pg_catalog.default"],"sortOptions":[0,0]}],"triggers":[{"name":"rcrr_guard_rows","type":31},{"name":"rcrr_guard_truncate","type":34}]},{"name":"recharge_refund_state","columns":[[1,"operation_id","uuid",true,null,"","",null],[2,"recharge_id","integer",true,null,"","",null],[3,"admission","text",true,null,"","","pg_catalog.default"],[4,"status","text",true,null,"","","pg_catalog.default"],[5,"wallet_state","text",true,null,"","","pg_catalog.default"],[6,"version","integer",true,null,"","",null],[7,"lease_id","uuid",false,null,"","",null],[8,"lease_until","bigint",false,null,"","",null],[9,"provider_refund_id","text",false,null,"","","pg_catalog.default"],[10,"attempt_count","integer",true,null,"","",null],[11,"next_query_at","bigint",false,null,"","",null],[12,"last_result_id","uuid",false,null,"","",null],[13,"created_at","bigint",true,null,"","",null],[14,"updated_at","bigint",true,null,"","",null]],"constraints":[{"name":"rcrs_last_result_fk","kind":"f","columns":["operation_id","last_result_id"],"target":"public.recharge_refund_result","references":["operation_id","result_id"],"definition":null,"fk":["s","a","a"]},{"name":"rcrs_operation_fk","kind":"f","columns":["operation_id","recharge_id","admission"],"target":"public.recharge_refund_operation","references":["operation_id","recharge_id","admission"],"definition":null,"fk":["s","a","a"]},{"name":"rcrs_pk","kind":"p","columns":["operation_id"],"target":null,"references":[],"definition":null,"fk":null},{"name":"rcrs_valid_ck","kind":"c","columns":["operation_id","recharge_id","admission","status","wallet_state","version","lease_id","lease_until","provider_refund_id","attempt_count","next_query_at","last_result_id","created_at","updated_at"],"target":null,"references":[],"definition":"CHECK (recharge_refund_valid_v1('state'::text, jsonb_build_array(operation_id, recharge_id, admission, status, wallet_state, version, lease_id, lease_until, provider_refund_id, attempt_count, next_query_at, last_result_id, created_at, updated_at)))","fk":null}],"indexes":[{"name":"rcrs_due","columns":["status","next_query_at","operation_id"],"unique":false,"primary":false,"predicate":null,"constraint":null,"keyCount":3,"attributeCount":3,"operators":["pg_catalog.text_ops","pg_catalog.int8_ops","pg_catalog.uuid_ops"],"collations":["pg_catalog.default",null,null],"sortOptions":[0,0,0]},{"name":"rcrs_effective_recharge_uq","columns":["recharge_id"],"unique":true,"primary":false,"predicate":"(wallet_state <> 'released'::text)","constraint":null,"keyCount":1,"attributeCount":1,"operators":["pg_catalog.int4_ops"],"collations":[null],"sortOptions":[0]},{"name":"rcrs_pk","columns":["operation_id"],"unique":true,"primary":true,"predicate":null,"constraint":"rcrs_pk","keyCount":1,"attributeCount":1,"operators":["pg_catalog.uuid_ops"],"collations":[null],"sortOptions":[0]}],"triggers":[{"name":"rcrs_guard_rows","type":31},{"name":"rcrs_guard_truncate","type":34}]}],"functions":[{"name":"recharge_refund_guard_v1","args":"","result":"trigger","language":"plpgsql","volatility":"v","parallel":"u","security":false,"body":"BEGIN\n IF TG_OP IN('DELETE','TRUNCATE') OR (TG_TABLE_NAME<>'recharge_refund_state' AND TG_OP='UPDATE') THEN\n  RAISE EXCEPTION 'Recharge refund evidence is immutable' USING ERRCODE='42501';\n END IF;\n -- Record-field expressions are planned only inside the matching relation and\n -- operation branch. Boolean AND does not protect NEW/OLD field resolution.\n IF TG_TABLE_NAME='recharge_refund_state' THEN\n  IF TG_OP='INSERT' THEN\n   IF NEW.status<>'RESERVED' OR NEW.wallet_state<>'held' OR NEW.version<>0 OR NEW.attempt_count<>0\n    OR NEW.lease_id IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.provider_refund_id IS NOT NULL\n    OR NEW.next_query_at IS NOT NULL OR NEW.last_result_id IS NOT NULL OR NEW.updated_at<>NEW.created_at THEN\n    RAISE EXCEPTION 'Recharge refund initial state is invalid' USING ERRCODE='23514';\n   END IF;\n  ELSIF TG_OP='UPDATE' THEN\n   IF (NEW.operation_id,NEW.recharge_id,NEW.admission,NEW.created_at) IS DISTINCT FROM\n      (OLD.operation_id,OLD.recharge_id,OLD.admission,OLD.created_at)\n    OR OLD.status IN('SUCCEEDED','FAILED') OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at\n    OR NEW.attempt_count<OLD.attempt_count OR NEW.attempt_count>OLD.attempt_count+1\n    OR NOT ((OLD.status='RESERVED' AND ((NEW.status='SUBMITTING' AND OLD.attempt_count=0 AND NEW.attempt_count=1)\n      OR (NEW.status='FAILED' AND OLD.attempt_count=0 AND NEW.attempt_count=0)))\n     OR (OLD.status='SUBMITTING' AND NEW.status IN('PROCESSING','UNKNOWN','SUCCEEDED','FAILED'))\n     OR (OLD.status IN('PROCESSING','UNKNOWN') AND NEW.status IN('PROCESSING','UNKNOWN','SUCCEEDED','FAILED'))) THEN\n    RAISE EXCEPTION 'Recharge refund state transition is invalid' USING ERRCODE='23514';\n   END IF;\n  END IF;\n END IF;\n RETURN NEW;\nEND"},{"name":"recharge_refund_lock_source_v1","args":"23","result":"integer","language":"plpgsql","volatility":"v","parallel":"u","security":true,"body":"DECLARE\n b pg_catalog.jsonb; comment_text pg_catalog.text; owner_oid pg_catalog.oid; login_oid pg_catalog.oid; locked_id pg_catalog.int4; acl_ok pg_catalog.bool;\nBEGIN\n IF $1 IS NULL OR $1<1 THEN\n  RAISE EXCEPTION 'Invalid recharge refund source identity' USING ERRCODE='22023';\n END IF;\n IF current_setting('server_version_num')::pg_catalog.int4/10000<>16\n  OR current_setting('role')<>'none'\n  OR current_setting('transaction_isolation')<>'read committed'\n  OR current_setting('transaction_read_only')<>'off'\n  OR current_setting('session_replication_role')<>'origin'\n  OR (SELECT setting::pg_catalog.int8 NOT BETWEEN 1 AND 5000 FROM pg_catalog.pg_settings WHERE name='statement_timeout')\n  OR (SELECT setting::pg_catalog.int8 NOT BETWEEN 1 AND 1000 FROM pg_catalog.pg_settings WHERE name='lock_timeout')\n  OR (SELECT setting::pg_catalog.int8 NOT BETWEEN 1 AND 5000 FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout') THEN\n  RAISE EXCEPTION 'Recharge refund source lock requires a direct bounded PG16 READ COMMITTED write transaction' USING ERRCODE='42501';\n END IF;\n SELECT r.oid INTO owner_oid FROM pg_catalog.pg_roles r WHERE r.rolname=current_user AND r.rolsuper AND r.rolcanlogin;\n SELECT r.oid INTO login_oid FROM pg_catalog.pg_roles r WHERE r.rolname=session_user;\n IF owner_oid IS NULL OR login_oid IS NULL OR owner_oid=login_oid\n  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid() AND a.usesysid=login_oid) THEN\n  RAISE EXCEPTION 'Recharge refund source lock owner/login is invalid' USING ERRCODE='42501';\n END IF;\n IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(731729,0) THEN\n  RAISE EXCEPTION 'Recharge refund source maintenance is in progress' USING ERRCODE='55P03';\n END IF;\n SELECT pg_catalog.obj_description(c.oid,'pg_class') INTO comment_text\n  FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.recharge_refund_operation') AND c.relowner=owner_oid;\n IF comment_text IS NULL OR octet_length(comment_text)>4096 OR comment_text='recharge-refund-storage-v1' THEN\n  RAISE EXCEPTION 'Recharge refund source lock is not explicitly commissioned' USING ERRCODE='42501';\n END IF;\n b:=comment_text::pg_catalog.jsonb;\n IF jsonb_typeof(b) IS DISTINCT FROM 'object' THEN\n  RAISE EXCEPTION 'Recharge refund source binding is invalid' USING ERRCODE='42501';\n END IF;\n IF NOT (b ?& ARRAY['version','database','databaseOid','maintenance','maintenanceOid','app','appOid','admin','adminOid','financial','financialOid','manager','managerOid']::pg_catalog.text[])\n  OR b-ARRAY['version','database','databaseOid','maintenance','maintenanceOid','app','appOid','admin','adminOid','financial','financialOid','manager','managerOid']::pg_catalog.text[]<>'{}'::pg_catalog.jsonb\n  OR EXISTS(SELECT 1 FROM jsonb_each(b) e WHERE jsonb_typeof(e.value)<>'string')\n  OR b->>'version'<>'recharge-refund-runtime-v1'\n  OR b->>'database'<>current_database()\n  OR b->>'databaseOid' IS DISTINCT FROM (SELECT d.oid::pg_catalog.text FROM pg_catalog.pg_database d WHERE d.datname=current_database())\n  OR b->>'maintenance'<>current_user OR b->>'maintenanceOid'<>owner_oid::pg_catalog.text\n  OR NOT EXISTS(SELECT 1 FROM (VALUES ('maintenance'),('app'),('admin'),('financial'),('manager')) k(role_key)\n    WHERE k.role_key IN('admin','app','financial') AND b->>k.role_key=session_user AND b->>(k.role_key||'Oid')=login_oid::pg_catalog.text)\n  OR (SELECT count(*)<>5 OR count(DISTINCT r.oid)<>5\n    OR NOT bool_and(r.oid IS NOT NULL AND r.oid::pg_catalog.text=b->>(k.role_key||'Oid') AND r.rolcanlogin\n      AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE')\n      AND pg_catalog.has_database_privilege(r.oid,current_database(),'CONNECT')\n      AND CASE WHEN k.role_key='maintenance' THEN r.rolsuper AND r.oid=owner_oid\n       ELSE NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)\n        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid=r.oid OR m.member=r.oid)\n        AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET')\n        AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM')\n        AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')\n        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'\n          AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))\n        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d\n          WHERE d.refclassid='pg_catalog.pg_authid'::pg_catalog.regclass AND d.refobjid=r.oid AND d.deptype='o') END)\n    FROM (VALUES ('maintenance'),('app'),('admin'),('financial'),('manager')) k(role_key) LEFT JOIN pg_catalog.pg_roles r ON r.rolname=b->>k.role_key) THEN\n  RAISE EXCEPTION 'Recharge refund source binding/login has drifted' USING ERRCODE='42501';\n END IF;\n IF (SELECT count(*)<>7 OR bool_or(c.relowner<>owner_oid OR c.relkind<>'r' OR c.relpersistence<>'p'\n     OR c.relispartition OR c.relrowsecurity OR c.relforcerowsecurity)\n    FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::pg_catalog.regnamespace\n    AND c.relname IN('store_order','user_recharge','other_order','recharge_refund_operation','recharge_refund_attempt','recharge_refund_result','recharge_refund_state'))\n  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc f\n    WHERE f.oid=pg_catalog.to_regprocedure('public.recharge_refund_lock_source_v1(integer)')\n    AND f.proowner=owner_oid AND f.prosecdef AND f.proconfig=ARRAY['search_path=pg_catalog']::pg_catalog.text[]\n    AND f.proargtypes='23'::pg_catalog.oidvector AND f.prorettype='pg_catalog.int4'::pg_catalog.regtype\n    AND f.prolang=(SELECT l.oid FROM pg_catalog.pg_language l WHERE l.lanname='plpgsql'))\n  OR (SELECT count(*)<>3 OR bool_or(f.proowner<>owner_oid)\n    FROM pg_catalog.pg_proc f WHERE f.pronamespace='public'::pg_catalog.regnamespace\n     AND f.proname IN('recharge_refund_valid_v1','recharge_refund_guard_v1','recharge_refund_lock_source_v1')) THEN\n  RAISE EXCEPTION 'Recharge refund source lock object ownership has drifted' USING ERRCODE='42501';\n END IF;\n WITH tt AS (SELECT c.* FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::pg_catalog.regnamespace AND c.relname IN('recharge_refund_operation','recharge_refund_attempt','recharge_refund_result','recharge_refund_state')),\n ff AS (SELECT f.* FROM pg_catalog.pg_proc f WHERE f.pronamespace='public'::pg_catalog.regnamespace\n  AND f.proname IN('recharge_refund_valid_v1','recharge_refund_guard_v1','recharge_refund_lock_source_v1')),\n actual_acl(scope,object_name,column_name,grantee,grantor,privilege,grantable) AS (\n  SELECT 'table',t.relname::pg_catalog.text,''::pg_catalog.text,a.grantee::pg_catalog.text,a.grantor::pg_catalog.text,a.privilege_type,a.is_grantable\n   FROM tt t CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(t.relacl,pg_catalog.acldefault('r',t.relowner))) a\n  UNION ALL SELECT 'column',t.relname::pg_catalog.text,c.attname::pg_catalog.text,a.grantee::pg_catalog.text,a.grantor::pg_catalog.text,a.privilege_type,a.is_grantable\n   FROM tt t JOIN pg_catalog.pg_attribute c ON c.attrelid=t.oid AND c.attnum>0 CROSS JOIN LATERAL pg_catalog.aclexplode(c.attacl) a\n  UNION ALL SELECT 'function',f.proname::pg_catalog.text,''::pg_catalog.text,a.grantee::pg_catalog.text,a.grantor::pg_catalog.text,a.privilege_type,a.is_grantable\n   FROM ff f CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a),\n owner_acl(scope,object_name,column_name,grantee,grantor,privilege,grantable) AS (\n  SELECT 'table',t.relname::pg_catalog.text,''::pg_catalog.text,t.relowner::pg_catalog.text,t.relowner::pg_catalog.text,p.privilege,false\n   FROM tt t CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(privilege)\n  UNION ALL SELECT 'function',f.proname::pg_catalog.text,''::pg_catalog.text,f.proowner::pg_catalog.text,f.proowner::pg_catalog.text,'EXECUTE',false FROM ff f),\n runtime_acl(scope,object_name,column_name,grantee,grantor,privilege,grantable) AS (\n  SELECT x.scope,x.object_name,x.column_name,r.oid::pg_catalog.text,owner_oid::pg_catalog.text,x.privilege,false\n   FROM (VALUES ('table','recharge_refund_operation','','admin','SELECT'),\n('table','recharge_refund_operation','','admin','INSERT'),\n('table','recharge_refund_state','','admin','SELECT'),\n('table','recharge_refund_state','','admin','INSERT'),\n('table','recharge_refund_attempt','','admin','SELECT'),\n('table','recharge_refund_attempt','','admin','INSERT'),\n('table','recharge_refund_result','','admin','SELECT'),\n('table','recharge_refund_result','','admin','INSERT'),\n('column','recharge_refund_state','status','admin','UPDATE'),\n('column','recharge_refund_state','wallet_state','admin','UPDATE'),\n('column','recharge_refund_state','version','admin','UPDATE'),\n('column','recharge_refund_state','lease_id','admin','UPDATE'),\n('column','recharge_refund_state','lease_until','admin','UPDATE'),\n('column','recharge_refund_state','provider_refund_id','admin','UPDATE'),\n('column','recharge_refund_state','attempt_count','admin','UPDATE'),\n('column','recharge_refund_state','next_query_at','admin','UPDATE'),\n('column','recharge_refund_state','last_result_id','admin','UPDATE'),\n('column','recharge_refund_state','updated_at','admin','UPDATE'),\n('function','recharge_refund_valid_v1','','admin','EXECUTE'),\n('function','recharge_refund_lock_source_v1','','admin','EXECUTE'),\n('table','recharge_refund_operation','','app','SELECT'),\n('table','recharge_refund_state','','app','SELECT'),\n('table','recharge_refund_attempt','','app','SELECT'),\n('table','recharge_refund_attempt','','app','INSERT'),\n('table','recharge_refund_result','','app','SELECT'),\n('table','recharge_refund_result','','app','INSERT'),\n('column','recharge_refund_state','status','app','UPDATE'),\n('column','recharge_refund_state','wallet_state','app','UPDATE'),\n('column','recharge_refund_state','version','app','UPDATE'),\n('column','recharge_refund_state','lease_id','app','UPDATE'),\n('column','recharge_refund_state','lease_until','app','UPDATE'),\n('column','recharge_refund_state','provider_refund_id','app','UPDATE'),\n('column','recharge_refund_state','attempt_count','app','UPDATE'),\n('column','recharge_refund_state','next_query_at','app','UPDATE'),\n('column','recharge_refund_state','last_result_id','app','UPDATE'),\n('column','recharge_refund_state','updated_at','app','UPDATE'),\n('function','recharge_refund_valid_v1','','app','EXECUTE'),\n('function','recharge_refund_lock_source_v1','','app','EXECUTE'),\n('table','recharge_refund_operation','','financial','SELECT'),\n('table','recharge_refund_state','','financial','SELECT'),\n('table','recharge_refund_attempt','','financial','SELECT'),\n('table','recharge_refund_attempt','','financial','INSERT'),\n('table','recharge_refund_result','','financial','SELECT'),\n('table','recharge_refund_result','','financial','INSERT'),\n('column','recharge_refund_state','status','financial','UPDATE'),\n('column','recharge_refund_state','wallet_state','financial','UPDATE'),\n('column','recharge_refund_state','version','financial','UPDATE'),\n('column','recharge_refund_state','lease_id','financial','UPDATE'),\n('column','recharge_refund_state','lease_until','financial','UPDATE'),\n('column','recharge_refund_state','provider_refund_id','financial','UPDATE'),\n('column','recharge_refund_state','attempt_count','financial','UPDATE'),\n('column','recharge_refund_state','next_query_at','financial','UPDATE'),\n('column','recharge_refund_state','last_result_id','financial','UPDATE'),\n('column','recharge_refund_state','updated_at','financial','UPDATE'),\n('function','recharge_refund_valid_v1','','financial','EXECUTE'),\n('function','recharge_refund_lock_source_v1','','financial','EXECUTE')) x(scope,object_name,column_name,role_key,privilege)\n   JOIN pg_catalog.pg_roles r ON r.rolname=b->>x.role_key AND r.oid::pg_catalog.text=b->>(x.role_key||'Oid'))\n SELECT (SELECT jsonb_agg(to_jsonb(a) ORDER BY scope,object_name,column_name,grantee,grantor,privilege,grantable) FROM actual_acl a)\n  IS NOT DISTINCT FROM\n  (SELECT jsonb_agg(to_jsonb(a) ORDER BY scope,object_name,column_name,grantee,grantor,privilege,grantable)\n   FROM (SELECT * FROM owner_acl UNION ALL SELECT * FROM runtime_acl) a) INTO acl_ok;\n IF acl_ok IS DISTINCT FROM true THEN\n  RAISE EXCEPTION 'Recharge refund source lock runtime ACLs have drifted' USING ERRCODE='42501';\n END IF;\n LOCK TABLE ONLY public.store_order,ONLY public.user_recharge,ONLY public.other_order IN SHARE MODE NOWAIT;\n SELECT r.id INTO locked_id FROM public.user_recharge r WHERE r.id=$1 FOR UPDATE NOWAIT;\n RETURN locked_id;\nEND"},{"name":"recharge_refund_valid_v1","args":"25 3802","result":"boolean","language":"sql","volatility":"i","parallel":"s","security":false,"body":"\nSELECT COALESCE(CASE $1\n WHEN 'operation' THEN jsonb_array_length($2)=22 AND ($2->>0) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND ($2->>1)::bigint>0 AND ($2->>2) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND ($2->>3) ~ '^[a-f0-9]{64}$'\n  AND ($2->>4)::bigint>0 AND ($2->>20)::bigint>0 AND ($2->>21) ~ '^[a-f0-9]{64}$' AND CASE WHEN ($2->>18)='abandoned' THEN\n    NOT EXISTS(SELECT 1 FROM generate_series(5,17) AS indexes(i) WHERE $2->i<>'null'::jsonb) AND $2->19='null'::jsonb\n  ELSE ($2->>5)::bigint>0 AND char_length(($2->>6)) BETWEEN 1 AND 32 AND ($2->>6) !~ '[\u0001-\u001f]'\n  AND ((($2->>7) IN('wechat','alipay') AND ($2->>8) ~ '^[a-z][a-z0-9_-]{0,31}$' AND char_length(($2->>9)) BETWEEN 1 AND 100 AND ($2->>9) !~ '[\u0001-\u001f]' AND jsonb_typeof($2->10)='object' AND octet_length(($2->10)::text)<=16384 AND ($2->>11) ~ '^[a-f0-9]{64}$')\n    OR (($2->>18)='rejected_insufficient' AND NOT EXISTS(SELECT 1 FROM generate_series(7,11) AS indexes(i) WHERE $2->i<>'null'::jsonb)))\n  AND ($2->>12)::bigint BETWEEN 1 AND 999999999999 AND ($2->>13)::bigint BETWEEN 0 AND 999999999999\n  AND ($2->>15)::bigint BETWEEN 1 AND 1999999999998 AND jsonb_typeof($2->14)='boolean'\n  AND ($2->>15)::bigint=($2->>12)::bigint+CASE WHEN ($2->>14)::boolean THEN ($2->>13)::bigint ELSE 0 END\n  AND ($2->>16)::bigint BETWEEN -999999999999 AND 999999999999 AND ($2->>17)::bigint BETWEEN -999999999999 AND 999999999999\n  AND ((($2->>18)='reserved' AND ($2->>16)::bigint>=($2->>15)::bigint AND ($2->>17)::bigint=($2->>16)::bigint-($2->>15)::bigint AND ($2->>19)='CNSCR'||replace(($2->>0),'-',''))\n    OR (($2->>18)='rejected_insufficient' AND ($2->>16)::bigint<($2->>15)::bigint AND ($2->>17)::bigint=($2->>16)::bigint AND $2->19='null'::jsonb)) END\n WHEN 'attempt' THEN jsonb_array_length($2)=9 AND ($2->>0) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND ($2->>1) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND ($2->>2)::bigint>0\n  AND ((($2->>3)='request' AND ($2->>2)::bigint=1) OR (($2->>3)='query' AND ($2->>2)::bigint>1))\n  AND ($2->>4) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND ($2->>5) ~ '^[a-f0-9]{64}$' AND jsonb_typeof($2->6)='object' AND octet_length(($2->6)::text)<=16384 AND ($2->>7)::bigint>0 AND ($2->>8) ~ '^[a-f0-9]{64}$'\n WHEN 'result' THEN jsonb_array_length($2)=10 AND ($2->>0) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND ($2->>1) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND ($2->2='null'::jsonb OR ($2->>2) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')\n  AND ($2->>3) IN('request','query','callback','local_cancel','local_settlement','local_release')\n  AND ($2->>4) ~ '^[A-Za-z0-9._:-]{1,128}$' AND ($2->>5) IN('SUCCESS','PROCESSING','CLOSED','ABNORMAL','FAILED','UNKNOWN','NOT_FOUND')\n  AND jsonb_typeof($2->6)='object' AND octet_length(($2->6)::text)<=16384 AND ($2->>7) ~ '^[a-f0-9]{64}$' AND ($2->>8)::bigint>0 AND ($2->9='null'::jsonb OR ($2->>9) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') AND ($2->9='null'::jsonb OR $2->9<>$2->0)\n  AND ((($2->>3) IN('request','query') AND $2->2<>'null'::jsonb AND $2->9='null'::jsonb)\n    OR (($2->>3)='callback' AND $2->2='null'::jsonb AND $2->9='null'::jsonb)\n    OR (($2->>3)='local_cancel' AND $2->2='null'::jsonb AND $2->9='null'::jsonb AND ($2->>5)='CLOSED')\n    OR (($2->>3) IN('local_settlement','local_release') AND $2->2='null'::jsonb AND $2->9<>'null'::jsonb AND ($2->>5)='SUCCESS'))\n WHEN 'state' THEN jsonb_array_length($2)=14 AND ($2->>0) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND ($2->>1)::bigint>0 AND ($2->>2)='reserved'\n  AND ($2->>3) IN('RESERVED','SUBMITTING','PROCESSING','UNKNOWN','SUCCEEDED','FAILED') AND ($2->>5)::bigint>=0\n  AND ((($2->>3)='SUCCEEDED' AND ($2->>4)='captured') OR (($2->>3)='FAILED' AND ($2->>4)='released')\n    OR (($2->>3) IN('RESERVED','SUBMITTING','PROCESSING','UNKNOWN') AND ($2->>4)='held'))\n  AND ($2->6='null'::jsonb OR ($2->>6) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') AND ($2->7='null'::jsonb OR ($2->>7)::bigint>0) AND (($2->6='null'::jsonb)=($2->7='null'::jsonb))\n  AND ($2->8='null'::jsonb OR char_length(($2->>8)) BETWEEN 1 AND 128 AND ($2->>8) !~ '[\u0001-\u001f]') AND ($2->>9)::bigint>=0 AND ($2->10='null'::jsonb OR ($2->>10)::bigint>0) AND ($2->11='null'::jsonb OR ($2->>11) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')\n  AND ($2->>12)::bigint>0 AND ($2->>13)::bigint>=($2->>12)::bigint\n  AND (($2->>3) NOT IN('SUCCEEDED','FAILED','RESERVED') OR ($2->6='null'::jsonb AND $2->10='null'::jsonb))\n  AND (($2->>3)<>'SUBMITTING' OR $2->6<>'null'::jsonb)\n ELSE false END,false)\n"}],"classes":["rcra_ordinal_uq","rcra_pk","rcra_result_identity_uq","rcra_single_request_uq","rcro_admin_key_uq","rcro_number_uq","rcro_pk","rcro_recharge_history","rcro_state_identity_uq","rcrr_attempt_uq","rcrr_operation_history","rcrr_operation_result_uq","rcrr_pk","rcrr_source_uq","rcrs_due","rcrs_effective_recharge_uq","rcrs_pk","recharge_refund_attempt","recharge_refund_operation","recharge_refund_result","recharge_refund_state"],"types":["_recharge_refund_attempt","_recharge_refund_operation","_recharge_refund_result","_recharge_refund_state","recharge_refund_attempt","recharge_refund_operation","recharge_refund_result","recharge_refund_state"],"constraints":["rcra_operation_fk","rcra_ordinal_uq","rcra_pk","rcra_result_identity_uq","rcra_valid_ck","rcro_admin_key_uq","rcro_number_uq","rcro_pk","rcro_state_identity_uq","rcro_valid_ck","rcrr_attempt_fk","rcrr_attempt_uq","rcrr_cause_fk","rcrr_operation_fk","rcrr_operation_result_uq","rcrr_pk","rcrr_source_uq","rcrr_valid_ck","rcrs_last_result_fk","rcrs_operation_fk","rcrs_pk","rcrs_valid_ck"],"triggers":["rcra_guard_rows","rcra_guard_truncate","rcro_guard_rows","rcro_guard_truncate","rcrr_guard_rows","rcrr_guard_truncate","rcrs_guard_rows","rcrs_guard_truncate"]}$rcr_shape$::jsonb
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
  AND (SELECT count(*) FROM ri_constraints)=6
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
SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND (c.relname LIKE 'recharge\_refund\_%' ESCAPE '\' OR c.relname LIKE 'rcro\_%' ESCAPE '\'
  OR c.relname LIKE 'rcra\_%' ESCAPE '\' OR c.relname LIKE 'rcrr\_%' ESCAPE '\' OR c.relname LIKE 'rcrs\_%' ESCAPE '\'))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND (p.proname LIKE 'recharge\_refund\_%' ESCAPE '\' OR p.proname LIKE 'rcro\_%' ESCAPE '\'
  OR p.proname LIKE 'rcra\_%' ESCAPE '\' OR p.proname LIKE 'rcrr\_%' ESCAPE '\' OR p.proname LIKE 'rcrs\_%' ESCAPE '\'))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_type t WHERE t.typnamespace='public'::regnamespace AND ((t.typname LIKE 'recharge\_refund\_%' ESCAPE '\' OR t.typname LIKE 'rcro\_%' ESCAPE '\'
  OR t.typname LIKE 'rcra\_%' ESCAPE '\' OR t.typname LIKE 'rcrr\_%' ESCAPE '\' OR t.typname LIKE 'rcrs\_%' ESCAPE '\') OR t.typname LIKE '\_recharge\_refund\_%' ESCAPE '\' OR t.typname LIKE '\_rcro\_%' ESCAPE '\'
 OR t.typname LIKE '\_rcra\_%' ESCAPE '\' OR t.typname LIKE '\_rcrr\_%' ESCAPE '\' OR t.typname LIKE '\_rcrs\_%' ESCAPE '\'))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.connamespace='public'::regnamespace AND (k.conname LIKE 'recharge\_refund\_%' ESCAPE '\' OR k.conname LIKE 'rcro\_%' ESCAPE '\'
  OR k.conname LIKE 'rcra\_%' ESCAPE '\' OR k.conname LIKE 'rcrr\_%' ESCAPE '\' OR k.conname LIKE 'rcrs\_%' ESCAPE '\'))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_trigger g WHERE (g.tgname LIKE 'recharge\_refund\_%' ESCAPE '\' OR g.tgname LIKE 'rcro\_%' ESCAPE '\'
  OR g.tgname LIKE 'rcra\_%' ESCAPE '\' OR g.tgname LIKE 'rcrr\_%' ESCAPE '\' OR g.tgname LIKE 'rcrs\_%' ESCAPE '\')) AS present,
 COALESCE((SELECT safe FROM source),false) AS source_safe,(SELECT snapshot FROM source) AS source,
 COALESCE((SELECT safe FROM structural),false) AS structural,
 COALESCE((SELECT owner_only FROM acl),false) AS owner_only,
 COALESCE((SELECT safe FROM binding_valid),false) AS binding_safe,
 COALESCE((SELECT commissioned FROM acl),false) AS commissioned_acl,
 (SELECT value FROM binding) AS binding,
 (SELECT oid::text FROM owner_role) AS maintenance_oid,
 (SELECT rolname FROM owner_role) AS maintenance,
 COALESCE((SELECT value='recharge-refund-storage-v1' FROM op_comment),false) AS unbound
$recharge_refund_inspection$;
BEGIN
 IF current_setting('server_version_num')::integer/10000<>16 OR current_user<>session_user
  OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off'
  OR current_setting('search_path')<>'pg_catalog, public, pg_temp' OR current_setting('row_security')<>'off'
  OR current_setting('session_replication_role')<>'origin'
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper AND rolcanlogin)
  OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
  RAISE EXCEPTION 'Recharge refund installation requires a direct PG16 maintenance owner READ COMMITTED transaction';
 END IF;
 IF NOT pg_try_advisory_xact_lock(731729,0) THEN
  RAISE EXCEPTION 'Recharge refund installation already running';
 END IF;
 IF to_regclass('public.user_recharge') IS NULL OR to_regclass('user_recharge') IS DISTINCT FROM to_regclass('public.user_recharge') THEN
  RAISE EXCEPTION 'Recharge refund requires the existing public recharge table';
 END IF;
 LOCK TABLE ONLY public.user_recharge IN ACCESS EXCLUSIVE MODE NOWAIT;
 EXECUTE inspection_sql INTO before_state;
 IF before_state.source_safe IS DISTINCT FROM true
  OR before_state.maintenance_oid IS DISTINCT FROM (SELECT oid::text FROM pg_roles WHERE rolname=current_user) THEN
  RAISE EXCEPTION 'Recharge refund source column/owner drift';
 END IF;
 IF before_state.present THEN
  IF before_state.structural IS DISTINCT FROM true OR before_state.source->>'type'<>'numeric(12,2)'
   OR NOT (before_state.owner_only OR (before_state.binding_safe AND before_state.commissioned_acl))
   OR NOT (before_state.unbound OR before_state.binding_safe) THEN
   RAISE EXCEPTION 'Recharge refund namespace is partial or its catalog/ACL/binding has drifted';
  END IF;
  LOCK TABLE ONLY public.recharge_refund_operation,ONLY public.recharge_refund_attempt,
   ONLY public.recharge_refund_result,ONLY public.recharge_refund_state IN ACCESS EXCLUSIVE MODE NOWAIT;
 END IF;
 original_source:=before_state.source;
 IF before_state.source->>'type'='numeric(10,2)' THEN
  ALTER TABLE ONLY public.user_recharge ALTER COLUMN refund_price TYPE numeric(12,2);
 END IF;
 IF NOT before_state.present THEN

CREATE FUNCTION public.recharge_refund_valid_v1(text,jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path=pg_catalog
AS $rcr_valid$
SELECT COALESCE(CASE $1
 WHEN 'operation' THEN jsonb_array_length($2)=22 AND ($2->>0) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND ($2->>1)::bigint>0 AND ($2->>2) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND ($2->>3) ~ '^[a-f0-9]{64}$'
  AND ($2->>4)::bigint>0 AND ($2->>20)::bigint>0 AND ($2->>21) ~ '^[a-f0-9]{64}$' AND CASE WHEN ($2->>18)='abandoned' THEN
    NOT EXISTS(SELECT 1 FROM generate_series(5,17) AS indexes(i) WHERE $2->i<>'null'::jsonb) AND $2->19='null'::jsonb
  ELSE ($2->>5)::bigint>0 AND char_length(($2->>6)) BETWEEN 1 AND 32 AND ($2->>6) !~ '[-]'
  AND ((($2->>7) IN('wechat','alipay') AND ($2->>8) ~ '^[a-z][a-z0-9_-]{0,31}$' AND char_length(($2->>9)) BETWEEN 1 AND 100 AND ($2->>9) !~ '[-]' AND jsonb_typeof($2->10)='object' AND octet_length(($2->10)::text)<=16384 AND ($2->>11) ~ '^[a-f0-9]{64}$')
    OR (($2->>18)='rejected_insufficient' AND NOT EXISTS(SELECT 1 FROM generate_series(7,11) AS indexes(i) WHERE $2->i<>'null'::jsonb)))
  AND ($2->>12)::bigint BETWEEN 1 AND 999999999999 AND ($2->>13)::bigint BETWEEN 0 AND 999999999999
  AND ($2->>15)::bigint BETWEEN 1 AND 1999999999998 AND jsonb_typeof($2->14)='boolean'
  AND ($2->>15)::bigint=($2->>12)::bigint+CASE WHEN ($2->>14)::boolean THEN ($2->>13)::bigint ELSE 0 END
  AND ($2->>16)::bigint BETWEEN -999999999999 AND 999999999999 AND ($2->>17)::bigint BETWEEN -999999999999 AND 999999999999
  AND ((($2->>18)='reserved' AND ($2->>16)::bigint>=($2->>15)::bigint AND ($2->>17)::bigint=($2->>16)::bigint-($2->>15)::bigint AND ($2->>19)='CNSCR'||replace(($2->>0),'-',''))
    OR (($2->>18)='rejected_insufficient' AND ($2->>16)::bigint<($2->>15)::bigint AND ($2->>17)::bigint=($2->>16)::bigint AND $2->19='null'::jsonb)) END
 WHEN 'attempt' THEN jsonb_array_length($2)=9 AND ($2->>0) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND ($2->>1) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND ($2->>2)::bigint>0
  AND ((($2->>3)='request' AND ($2->>2)::bigint=1) OR (($2->>3)='query' AND ($2->>2)::bigint>1))
  AND ($2->>4) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND ($2->>5) ~ '^[a-f0-9]{64}$' AND jsonb_typeof($2->6)='object' AND octet_length(($2->6)::text)<=16384 AND ($2->>7)::bigint>0 AND ($2->>8) ~ '^[a-f0-9]{64}$'
 WHEN 'result' THEN jsonb_array_length($2)=10 AND ($2->>0) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND ($2->>1) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND ($2->2='null'::jsonb OR ($2->>2) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
  AND ($2->>3) IN('request','query','callback','local_cancel','local_settlement','local_release')
  AND ($2->>4) ~ '^[A-Za-z0-9._:-]{1,128}$' AND ($2->>5) IN('SUCCESS','PROCESSING','CLOSED','ABNORMAL','FAILED','UNKNOWN','NOT_FOUND')
  AND jsonb_typeof($2->6)='object' AND octet_length(($2->6)::text)<=16384 AND ($2->>7) ~ '^[a-f0-9]{64}$' AND ($2->>8)::bigint>0 AND ($2->9='null'::jsonb OR ($2->>9) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') AND ($2->9='null'::jsonb OR $2->9<>$2->0)
  AND ((($2->>3) IN('request','query') AND $2->2<>'null'::jsonb AND $2->9='null'::jsonb)
    OR (($2->>3)='callback' AND $2->2='null'::jsonb AND $2->9='null'::jsonb)
    OR (($2->>3)='local_cancel' AND $2->2='null'::jsonb AND $2->9='null'::jsonb AND ($2->>5)='CLOSED')
    OR (($2->>3) IN('local_settlement','local_release') AND $2->2='null'::jsonb AND $2->9<>'null'::jsonb AND ($2->>5)='SUCCESS'))
 WHEN 'state' THEN jsonb_array_length($2)=14 AND ($2->>0) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND ($2->>1)::bigint>0 AND ($2->>2)='reserved'
  AND ($2->>3) IN('RESERVED','SUBMITTING','PROCESSING','UNKNOWN','SUCCEEDED','FAILED') AND ($2->>5)::bigint>=0
  AND ((($2->>3)='SUCCEEDED' AND ($2->>4)='captured') OR (($2->>3)='FAILED' AND ($2->>4)='released')
    OR (($2->>3) IN('RESERVED','SUBMITTING','PROCESSING','UNKNOWN') AND ($2->>4)='held'))
  AND ($2->6='null'::jsonb OR ($2->>6) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') AND ($2->7='null'::jsonb OR ($2->>7)::bigint>0) AND (($2->6='null'::jsonb)=($2->7='null'::jsonb))
  AND ($2->8='null'::jsonb OR char_length(($2->>8)) BETWEEN 1 AND 128 AND ($2->>8) !~ '[-]') AND ($2->>9)::bigint>=0 AND ($2->10='null'::jsonb OR ($2->>10)::bigint>0) AND ($2->11='null'::jsonb OR ($2->>11) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
  AND ($2->>12)::bigint>0 AND ($2->>13)::bigint>=($2->>12)::bigint
  AND (($2->>3) NOT IN('SUCCEEDED','FAILED','RESERVED') OR ($2->6='null'::jsonb AND $2->10='null'::jsonb))
  AND (($2->>3)<>'SUBMITTING' OR $2->6<>'null'::jsonb)
 ELSE false END,false)
$rcr_valid$;
REVOKE ALL ON FUNCTION public.recharge_refund_valid_v1(text,jsonb) FROM PUBLIC;
CREATE FUNCTION public.recharge_refund_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog
AS $rcr_guard$BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') OR (TG_TABLE_NAME<>'recharge_refund_state' AND TG_OP='UPDATE') THEN
  RAISE EXCEPTION 'Recharge refund evidence is immutable' USING ERRCODE='42501';
 END IF;
 -- Record-field expressions are planned only inside the matching relation and
 -- operation branch. Boolean AND does not protect NEW/OLD field resolution.
 IF TG_TABLE_NAME='recharge_refund_state' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.status<>'RESERVED' OR NEW.wallet_state<>'held' OR NEW.version<>0 OR NEW.attempt_count<>0
    OR NEW.lease_id IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.provider_refund_id IS NOT NULL
    OR NEW.next_query_at IS NOT NULL OR NEW.last_result_id IS NOT NULL OR NEW.updated_at<>NEW.created_at THEN
    RAISE EXCEPTION 'Recharge refund initial state is invalid' USING ERRCODE='23514';
   END IF;
  ELSIF TG_OP='UPDATE' THEN
   IF (NEW.operation_id,NEW.recharge_id,NEW.admission,NEW.created_at) IS DISTINCT FROM
      (OLD.operation_id,OLD.recharge_id,OLD.admission,OLD.created_at)
    OR OLD.status IN('SUCCEEDED','FAILED') OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at
    OR NEW.attempt_count<OLD.attempt_count OR NEW.attempt_count>OLD.attempt_count+1
    OR NOT ((OLD.status='RESERVED' AND ((NEW.status='SUBMITTING' AND OLD.attempt_count=0 AND NEW.attempt_count=1)
      OR (NEW.status='FAILED' AND OLD.attempt_count=0 AND NEW.attempt_count=0)))
     OR (OLD.status='SUBMITTING' AND NEW.status IN('PROCESSING','UNKNOWN','SUCCEEDED','FAILED'))
     OR (OLD.status IN('PROCESSING','UNKNOWN') AND NEW.status IN('PROCESSING','UNKNOWN','SUCCEEDED','FAILED'))) THEN
    RAISE EXCEPTION 'Recharge refund state transition is invalid' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END$rcr_guard$;
REVOKE ALL ON FUNCTION public.recharge_refund_guard_v1() FROM PUBLIC;
CREATE FUNCTION public.recharge_refund_lock_source_v1(integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $rcr_lock$DECLARE
 b pg_catalog.jsonb; comment_text pg_catalog.text; owner_oid pg_catalog.oid; login_oid pg_catalog.oid; locked_id pg_catalog.int4; acl_ok pg_catalog.bool;
BEGIN
 IF $1 IS NULL OR $1<1 THEN
  RAISE EXCEPTION 'Invalid recharge refund source identity' USING ERRCODE='22023';
 END IF;
 IF current_setting('server_version_num')::pg_catalog.int4/10000<>16
  OR current_setting('role')<>'none'
  OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off'
  OR current_setting('session_replication_role')<>'origin'
  OR (SELECT setting::pg_catalog.int8 NOT BETWEEN 1 AND 5000 FROM pg_catalog.pg_settings WHERE name='statement_timeout')
  OR (SELECT setting::pg_catalog.int8 NOT BETWEEN 1 AND 1000 FROM pg_catalog.pg_settings WHERE name='lock_timeout')
  OR (SELECT setting::pg_catalog.int8 NOT BETWEEN 1 AND 5000 FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout') THEN
  RAISE EXCEPTION 'Recharge refund source lock requires a direct bounded PG16 READ COMMITTED write transaction' USING ERRCODE='42501';
 END IF;
 SELECT r.oid INTO owner_oid FROM pg_catalog.pg_roles r WHERE r.rolname=current_user AND r.rolsuper AND r.rolcanlogin;
 SELECT r.oid INTO login_oid FROM pg_catalog.pg_roles r WHERE r.rolname=session_user;
 IF owner_oid IS NULL OR login_oid IS NULL OR owner_oid=login_oid
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid() AND a.usesysid=login_oid) THEN
  RAISE EXCEPTION 'Recharge refund source lock owner/login is invalid' USING ERRCODE='42501';
 END IF;
 IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(731729,0) THEN
  RAISE EXCEPTION 'Recharge refund source maintenance is in progress' USING ERRCODE='55P03';
 END IF;
 SELECT pg_catalog.obj_description(c.oid,'pg_class') INTO comment_text
  FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.recharge_refund_operation') AND c.relowner=owner_oid;
 IF comment_text IS NULL OR octet_length(comment_text)>4096 OR comment_text='recharge-refund-storage-v1' THEN
  RAISE EXCEPTION 'Recharge refund source lock is not explicitly commissioned' USING ERRCODE='42501';
 END IF;
 b:=comment_text::pg_catalog.jsonb;
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'Recharge refund source binding is invalid' USING ERRCODE='42501';
 END IF;
 IF NOT (b ?& ARRAY['version','database','databaseOid','maintenance','maintenanceOid','app','appOid','admin','adminOid','financial','financialOid','manager','managerOid']::pg_catalog.text[])
  OR b-ARRAY['version','database','databaseOid','maintenance','maintenanceOid','app','appOid','admin','adminOid','financial','financialOid','manager','managerOid']::pg_catalog.text[]<>'{}'::pg_catalog.jsonb
  OR EXISTS(SELECT 1 FROM jsonb_each(b) e WHERE jsonb_typeof(e.value)<>'string')
  OR b->>'version'<>'recharge-refund-runtime-v1'
  OR b->>'database'<>current_database()
  OR b->>'databaseOid' IS DISTINCT FROM (SELECT d.oid::pg_catalog.text FROM pg_catalog.pg_database d WHERE d.datname=current_database())
  OR b->>'maintenance'<>current_user OR b->>'maintenanceOid'<>owner_oid::pg_catalog.text
  OR NOT EXISTS(SELECT 1 FROM (VALUES ('maintenance'),('app'),('admin'),('financial'),('manager')) k(role_key)
    WHERE k.role_key IN('admin','app','financial') AND b->>k.role_key=session_user AND b->>(k.role_key||'Oid')=login_oid::pg_catalog.text)
  OR (SELECT count(*)<>5 OR count(DISTINCT r.oid)<>5
    OR NOT bool_and(r.oid IS NOT NULL AND r.oid::pg_catalog.text=b->>(k.role_key||'Oid') AND r.rolcanlogin
      AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE')
      AND pg_catalog.has_database_privilege(r.oid,current_database(),'CONNECT')
      AND CASE WHEN k.role_key='maintenance' THEN r.rolsuper AND r.oid=owner_oid
       ELSE NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid=r.oid OR m.member=r.oid)
        AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET')
        AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM')
        AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d
          WHERE d.refclassid='pg_catalog.pg_authid'::pg_catalog.regclass AND d.refobjid=r.oid AND d.deptype='o') END)
    FROM (VALUES ('maintenance'),('app'),('admin'),('financial'),('manager')) k(role_key) LEFT JOIN pg_catalog.pg_roles r ON r.rolname=b->>k.role_key) THEN
  RAISE EXCEPTION 'Recharge refund source binding/login has drifted' USING ERRCODE='42501';
 END IF;
 IF (SELECT count(*)<>7 OR bool_or(c.relowner<>owner_oid OR c.relkind<>'r' OR c.relpersistence<>'p'
     OR c.relispartition OR c.relrowsecurity OR c.relforcerowsecurity)
    FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::pg_catalog.regnamespace
    AND c.relname IN('store_order','user_recharge','other_order','recharge_refund_operation','recharge_refund_attempt','recharge_refund_result','recharge_refund_state'))
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc f
    WHERE f.oid=pg_catalog.to_regprocedure('public.recharge_refund_lock_source_v1(integer)')
    AND f.proowner=owner_oid AND f.prosecdef AND f.proconfig=ARRAY['search_path=pg_catalog']::pg_catalog.text[]
    AND f.proargtypes='23'::pg_catalog.oidvector AND f.prorettype='pg_catalog.int4'::pg_catalog.regtype
    AND f.prolang=(SELECT l.oid FROM pg_catalog.pg_language l WHERE l.lanname='plpgsql'))
  OR (SELECT count(*)<>3 OR bool_or(f.proowner<>owner_oid)
    FROM pg_catalog.pg_proc f WHERE f.pronamespace='public'::pg_catalog.regnamespace
     AND f.proname IN('recharge_refund_valid_v1','recharge_refund_guard_v1','recharge_refund_lock_source_v1')) THEN
  RAISE EXCEPTION 'Recharge refund source lock object ownership has drifted' USING ERRCODE='42501';
 END IF;
 WITH tt AS (SELECT c.* FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::pg_catalog.regnamespace AND c.relname IN('recharge_refund_operation','recharge_refund_attempt','recharge_refund_result','recharge_refund_state')),
 ff AS (SELECT f.* FROM pg_catalog.pg_proc f WHERE f.pronamespace='public'::pg_catalog.regnamespace
  AND f.proname IN('recharge_refund_valid_v1','recharge_refund_guard_v1','recharge_refund_lock_source_v1')),
 actual_acl(scope,object_name,column_name,grantee,grantor,privilege,grantable) AS (
  SELECT 'table',t.relname::pg_catalog.text,''::pg_catalog.text,a.grantee::pg_catalog.text,a.grantor::pg_catalog.text,a.privilege_type,a.is_grantable
   FROM tt t CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(t.relacl,pg_catalog.acldefault('r',t.relowner))) a
  UNION ALL SELECT 'column',t.relname::pg_catalog.text,c.attname::pg_catalog.text,a.grantee::pg_catalog.text,a.grantor::pg_catalog.text,a.privilege_type,a.is_grantable
   FROM tt t JOIN pg_catalog.pg_attribute c ON c.attrelid=t.oid AND c.attnum>0 CROSS JOIN LATERAL pg_catalog.aclexplode(c.attacl) a
  UNION ALL SELECT 'function',f.proname::pg_catalog.text,''::pg_catalog.text,a.grantee::pg_catalog.text,a.grantor::pg_catalog.text,a.privilege_type,a.is_grantable
   FROM ff f CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a),
 owner_acl(scope,object_name,column_name,grantee,grantor,privilege,grantable) AS (
  SELECT 'table',t.relname::pg_catalog.text,''::pg_catalog.text,t.relowner::pg_catalog.text,t.relowner::pg_catalog.text,p.privilege,false
   FROM tt t CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(privilege)
  UNION ALL SELECT 'function',f.proname::pg_catalog.text,''::pg_catalog.text,f.proowner::pg_catalog.text,f.proowner::pg_catalog.text,'EXECUTE',false FROM ff f),
 runtime_acl(scope,object_name,column_name,grantee,grantor,privilege,grantable) AS (
  SELECT x.scope,x.object_name,x.column_name,r.oid::pg_catalog.text,owner_oid::pg_catalog.text,x.privilege,false
   FROM (VALUES ('table','recharge_refund_operation','','admin','SELECT'),
('table','recharge_refund_operation','','admin','INSERT'),
('table','recharge_refund_state','','admin','SELECT'),
('table','recharge_refund_state','','admin','INSERT'),
('table','recharge_refund_attempt','','admin','SELECT'),
('table','recharge_refund_attempt','','admin','INSERT'),
('table','recharge_refund_result','','admin','SELECT'),
('table','recharge_refund_result','','admin','INSERT'),
('column','recharge_refund_state','status','admin','UPDATE'),
('column','recharge_refund_state','wallet_state','admin','UPDATE'),
('column','recharge_refund_state','version','admin','UPDATE'),
('column','recharge_refund_state','lease_id','admin','UPDATE'),
('column','recharge_refund_state','lease_until','admin','UPDATE'),
('column','recharge_refund_state','provider_refund_id','admin','UPDATE'),
('column','recharge_refund_state','attempt_count','admin','UPDATE'),
('column','recharge_refund_state','next_query_at','admin','UPDATE'),
('column','recharge_refund_state','last_result_id','admin','UPDATE'),
('column','recharge_refund_state','updated_at','admin','UPDATE'),
('function','recharge_refund_valid_v1','','admin','EXECUTE'),
('function','recharge_refund_lock_source_v1','','admin','EXECUTE'),
('table','recharge_refund_operation','','app','SELECT'),
('table','recharge_refund_state','','app','SELECT'),
('table','recharge_refund_attempt','','app','SELECT'),
('table','recharge_refund_attempt','','app','INSERT'),
('table','recharge_refund_result','','app','SELECT'),
('table','recharge_refund_result','','app','INSERT'),
('column','recharge_refund_state','status','app','UPDATE'),
('column','recharge_refund_state','wallet_state','app','UPDATE'),
('column','recharge_refund_state','version','app','UPDATE'),
('column','recharge_refund_state','lease_id','app','UPDATE'),
('column','recharge_refund_state','lease_until','app','UPDATE'),
('column','recharge_refund_state','provider_refund_id','app','UPDATE'),
('column','recharge_refund_state','attempt_count','app','UPDATE'),
('column','recharge_refund_state','next_query_at','app','UPDATE'),
('column','recharge_refund_state','last_result_id','app','UPDATE'),
('column','recharge_refund_state','updated_at','app','UPDATE'),
('function','recharge_refund_valid_v1','','app','EXECUTE'),
('function','recharge_refund_lock_source_v1','','app','EXECUTE'),
('table','recharge_refund_operation','','financial','SELECT'),
('table','recharge_refund_state','','financial','SELECT'),
('table','recharge_refund_attempt','','financial','SELECT'),
('table','recharge_refund_attempt','','financial','INSERT'),
('table','recharge_refund_result','','financial','SELECT'),
('table','recharge_refund_result','','financial','INSERT'),
('column','recharge_refund_state','status','financial','UPDATE'),
('column','recharge_refund_state','wallet_state','financial','UPDATE'),
('column','recharge_refund_state','version','financial','UPDATE'),
('column','recharge_refund_state','lease_id','financial','UPDATE'),
('column','recharge_refund_state','lease_until','financial','UPDATE'),
('column','recharge_refund_state','provider_refund_id','financial','UPDATE'),
('column','recharge_refund_state','attempt_count','financial','UPDATE'),
('column','recharge_refund_state','next_query_at','financial','UPDATE'),
('column','recharge_refund_state','last_result_id','financial','UPDATE'),
('column','recharge_refund_state','updated_at','financial','UPDATE'),
('function','recharge_refund_valid_v1','','financial','EXECUTE'),
('function','recharge_refund_lock_source_v1','','financial','EXECUTE')) x(scope,object_name,column_name,role_key,privilege)
   JOIN pg_catalog.pg_roles r ON r.rolname=b->>x.role_key AND r.oid::pg_catalog.text=b->>(x.role_key||'Oid'))
 SELECT (SELECT jsonb_agg(to_jsonb(a) ORDER BY scope,object_name,column_name,grantee,grantor,privilege,grantable) FROM actual_acl a)
  IS NOT DISTINCT FROM
  (SELECT jsonb_agg(to_jsonb(a) ORDER BY scope,object_name,column_name,grantee,grantor,privilege,grantable)
   FROM (SELECT * FROM owner_acl UNION ALL SELECT * FROM runtime_acl) a) INTO acl_ok;
 IF acl_ok IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Recharge refund source lock runtime ACLs have drifted' USING ERRCODE='42501';
 END IF;
 LOCK TABLE ONLY public.store_order,ONLY public.user_recharge,ONLY public.other_order IN SHARE MODE NOWAIT;
 SELECT r.id INTO locked_id FROM public.user_recharge r WHERE r.id=$1 FOR UPDATE NOWAIT;
 RETURN locked_id;
END$rcr_lock$;
REVOKE ALL ON FUNCTION public.recharge_refund_lock_source_v1(integer) FROM PUBLIC;
CREATE TABLE public.recharge_refund_operation (
 operation_id uuid NOT NULL,
 admin_id integer NOT NULL,
 request_key uuid NOT NULL,
 request_hash text NOT NULL,
 recharge_id integer NOT NULL,
 buyer_uid integer,
 order_no text,
 provider text,
 payment_profile text,
 transaction_id text,
 payment_source jsonb,
 payment_signature text,
 principal_cents bigint,
 gift_cents bigint,
 reclaim_gift boolean,
 debit_cents bigint,
 wallet_before bigint,
 wallet_after bigint,
 admission text NOT NULL,
 out_refund_no text,
 created_at bigint NOT NULL,
 signature text NOT NULL,
 CONSTRAINT rcro_pk PRIMARY KEY (operation_id),
 CONSTRAINT rcro_admin_key_uq UNIQUE (admin_id,request_key),
 CONSTRAINT rcro_number_uq UNIQUE (out_refund_no),
 CONSTRAINT rcro_state_identity_uq UNIQUE (operation_id,recharge_id,admission),
 CONSTRAINT rcro_valid_ck CHECK(public.recharge_refund_valid_v1('operation',pg_catalog.jsonb_build_array(operation_id,admin_id,request_key,request_hash,recharge_id,buyer_uid,order_no,provider,payment_profile,transaction_id,payment_source,payment_signature,principal_cents,gift_cents,reclaim_gift,debit_cents,wallet_before,wallet_after,admission,out_refund_no,created_at,signature)))
);
CREATE INDEX rcro_recharge_history ON public.recharge_refund_operation (recharge_id,created_at,operation_id);
CREATE TRIGGER rcro_guard_rows BEFORE INSERT OR UPDATE OR DELETE ON public.recharge_refund_operation
 FOR EACH ROW EXECUTE FUNCTION public.recharge_refund_guard_v1();
CREATE TRIGGER rcro_guard_truncate BEFORE TRUNCATE ON public.recharge_refund_operation
 FOR EACH STATEMENT EXECUTE FUNCTION public.recharge_refund_guard_v1();
CREATE TABLE public.recharge_refund_attempt (
 attempt_id uuid NOT NULL,
 operation_id uuid NOT NULL,
 ordinal integer NOT NULL,
 kind text NOT NULL,
 lease_id uuid NOT NULL,
 request_hash text NOT NULL,
 payload jsonb NOT NULL,
 created_at bigint NOT NULL,
 signature text NOT NULL,
 CONSTRAINT rcra_pk PRIMARY KEY (attempt_id),
 CONSTRAINT rcra_ordinal_uq UNIQUE (operation_id,ordinal),
 CONSTRAINT rcra_result_identity_uq UNIQUE (operation_id,attempt_id,kind),
 CONSTRAINT rcra_operation_fk FOREIGN KEY (operation_id) REFERENCES public.recharge_refund_operation (operation_id),
 CONSTRAINT rcra_valid_ck CHECK(public.recharge_refund_valid_v1('attempt',pg_catalog.jsonb_build_array(attempt_id,operation_id,ordinal,kind,lease_id,request_hash,payload,created_at,signature)))
);
CREATE UNIQUE INDEX rcra_single_request_uq ON public.recharge_refund_attempt (operation_id) WHERE (kind = 'request'::text);
CREATE TRIGGER rcra_guard_rows BEFORE INSERT OR UPDATE OR DELETE ON public.recharge_refund_attempt
 FOR EACH ROW EXECUTE FUNCTION public.recharge_refund_guard_v1();
CREATE TRIGGER rcra_guard_truncate BEFORE TRUNCATE ON public.recharge_refund_attempt
 FOR EACH STATEMENT EXECUTE FUNCTION public.recharge_refund_guard_v1();
CREATE TABLE public.recharge_refund_result (
 result_id uuid NOT NULL,
 operation_id uuid NOT NULL,
 attempt_id uuid,
 source text NOT NULL,
 source_id text NOT NULL,
 status text NOT NULL,
 evidence jsonb NOT NULL,
 signature text NOT NULL,
 created_at bigint NOT NULL,
 caused_by_result_id uuid,
 CONSTRAINT rcrr_pk PRIMARY KEY (result_id),
 CONSTRAINT rcrr_operation_result_uq UNIQUE (operation_id,result_id),
 CONSTRAINT rcrr_source_uq UNIQUE (source,source_id),
 CONSTRAINT rcrr_attempt_uq UNIQUE (attempt_id),
 CONSTRAINT rcrr_operation_fk FOREIGN KEY (operation_id) REFERENCES public.recharge_refund_operation (operation_id),
 CONSTRAINT rcrr_attempt_fk FOREIGN KEY (operation_id,attempt_id,source) REFERENCES public.recharge_refund_attempt (operation_id,attempt_id,kind),
 CONSTRAINT rcrr_cause_fk FOREIGN KEY (operation_id,caused_by_result_id) REFERENCES public.recharge_refund_result (operation_id,result_id),
 CONSTRAINT rcrr_valid_ck CHECK(public.recharge_refund_valid_v1('result',pg_catalog.jsonb_build_array(result_id,operation_id,attempt_id,source,source_id,status,evidence,signature,created_at,caused_by_result_id)))
);
CREATE INDEX rcrr_operation_history ON public.recharge_refund_result (operation_id,created_at,result_id);
CREATE TRIGGER rcrr_guard_rows BEFORE INSERT OR UPDATE OR DELETE ON public.recharge_refund_result
 FOR EACH ROW EXECUTE FUNCTION public.recharge_refund_guard_v1();
CREATE TRIGGER rcrr_guard_truncate BEFORE TRUNCATE ON public.recharge_refund_result
 FOR EACH STATEMENT EXECUTE FUNCTION public.recharge_refund_guard_v1();
CREATE TABLE public.recharge_refund_state (
 operation_id uuid NOT NULL,
 recharge_id integer NOT NULL,
 admission text NOT NULL,
 status text NOT NULL,
 wallet_state text NOT NULL,
 version integer NOT NULL,
 lease_id uuid,
 lease_until bigint,
 provider_refund_id text,
 attempt_count integer NOT NULL,
 next_query_at bigint,
 last_result_id uuid,
 created_at bigint NOT NULL,
 updated_at bigint NOT NULL,
 CONSTRAINT rcrs_pk PRIMARY KEY (operation_id),
 CONSTRAINT rcrs_operation_fk FOREIGN KEY (operation_id,recharge_id,admission) REFERENCES public.recharge_refund_operation (operation_id,recharge_id,admission),
 CONSTRAINT rcrs_last_result_fk FOREIGN KEY (operation_id,last_result_id) REFERENCES public.recharge_refund_result (operation_id,result_id),
 CONSTRAINT rcrs_valid_ck CHECK(public.recharge_refund_valid_v1('state',pg_catalog.jsonb_build_array(operation_id,recharge_id,admission,status,wallet_state,version,lease_id,lease_until,provider_refund_id,attempt_count,next_query_at,last_result_id,created_at,updated_at)))
);
CREATE UNIQUE INDEX rcrs_effective_recharge_uq ON public.recharge_refund_state (recharge_id) WHERE (wallet_state <> 'released'::text);
CREATE INDEX rcrs_due ON public.recharge_refund_state (status,next_query_at,operation_id);
CREATE TRIGGER rcrs_guard_rows BEFORE INSERT OR UPDATE OR DELETE ON public.recharge_refund_state
 FOR EACH ROW EXECUTE FUNCTION public.recharge_refund_guard_v1();
CREATE TRIGGER rcrs_guard_truncate BEFORE TRUNCATE ON public.recharge_refund_state
 FOR EACH STATEMENT EXECUTE FUNCTION public.recharge_refund_guard_v1();
COMMENT ON TABLE public.recharge_refund_operation IS 'recharge-refund-storage-v1';

 END IF;
 EXECUTE inspection_sql INTO after_state;
 IF after_state.structural IS DISTINCT FROM true OR after_state.source->>'type'<>'numeric(12,2)'
  OR NOT (after_state.owner_only OR (after_state.binding_safe AND after_state.commissioned_acl))
  OR NOT (after_state.unbound OR after_state.binding_safe) THEN
  RAISE EXCEPTION 'Recharge refund catalog/ACL/binding failed after lock/create';
 END IF;
 IF (after_state.source-'type') IS DISTINCT FROM (original_source-'type') THEN
  RAISE EXCEPTION 'Recharge refund widening changed existing source identity/metadata';
 END IF;
 IF current_user<>session_user OR current_setting('session_replication_role')<>'origin'
  OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
  RAISE EXCEPTION 'Recharge refund installation environment changed';
 END IF;
END
$recharge_refund_install$;

COMMIT;
