import { sql,type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
export const CUSTOMER_PRODUCT_CATALOG_LOCK_KEY=731645;
export const CUSTOMER_PRODUCT_CATALOG_OWNER_SETTING='cinashop.customer_product_catalog_owner';
export const CUSTOMER_PRODUCT_CATALOG_RELATIONS=['store_product_category','store_product_label','category'] as const;
export function customerProductCatalogBodies(schema='public'){
  const s=pricingIdentifier(schema),prefix=`\nBEGIN\n  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' OR pg_catalog.current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'Customer product catalog locks require READ COMMITTED write transaction' USING ERRCODE='25000'; END IF;\n`;
  return[
    {name:'customer_product_lock_catalog_v1',args:'text, integer[]',argtypes:'25 1007',body:prefix+`  IF $1 IS NULL OR $1 NOT IN ('category','label') OR $2 IS NULL OR pg_catalog.cardinality($2)>100 OR (pg_catalog.cardinality($2)>0 AND pg_catalog.array_ndims($2)<>1) OR EXISTS(SELECT 1 FROM pg_catalog.unnest($2) AS ids(id) WHERE id IS NULL OR id<1) OR $2 IS DISTINCT FROM ARRAY(SELECT DISTINCT id FROM pg_catalog.unnest($2) AS ids(id) ORDER BY id) THEN RAISE EXCEPTION 'Invalid customer product catalog lock targets'; END IF;\n  LOCK TABLE ${s}.store_product_category,${s}.store_product_label,${s}.category IN SHARE MODE NOWAIT;\n  -- Table SHARE fences insert/delete and visible/invalid/ancestor phantoms.\n  -- Lock every catalog row in a fixed order, including selected ancestors.\n  PERFORM id FROM ${s}.store_product_category ORDER BY id FOR SHARE NOWAIT;\n  PERFORM id FROM ${s}.store_product_label ORDER BY id FOR SHARE NOWAIT;\n  PERFORM id FROM ${s}.category ORDER BY id FOR SHARE NOWAIT;\nEND\n`},
  ] as const;
}
export function customerProductCatalogQuery(schema='public'){
  pricingIdentifier(schema);const functions=customerProductCatalogBodies(schema);
  const expected=sql.join(functions.map(f=>sql`(${f.name}::text,${f.argtypes}::oidvector,${f.body}::text)`),sql`, `);
  return sql`WITH ns AS(SELECT * FROM pg_catalog.pg_namespace WHERE nspname=${schema}),relations AS(SELECT c.* FROM pg_catalog.pg_class c JOIN ns ON ns.oid=c.relnamespace WHERE c.relname IN('store_product_category','store_product_label','category')),
    expected(name,args,body) AS(VALUES ${expected}),routines AS(SELECT p.* FROM pg_catalog.pg_proc p JOIN ns ON ns.oid=p.pronamespace WHERE p.proname IN('customer_product_lock_catalog_v1')),
    owner AS(SELECT r.* FROM pg_catalog.pg_roles r WHERE r.oid=(SELECT min(proowner) FROM routines))
    SELECT current_setting('server_version_num')::int/10000=16 AND (SELECT count(*)=3 AND bool_and(relkind='r' AND relpersistence='p' AND NOT relispartition AND NOT relrowsecurity AND NOT relforcerowsecurity) FROM relations)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i JOIN relations r ON r.oid IN(i.inhrelid,i.inhparent)) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy p JOIN relations r ON r.oid=p.polrelid) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite w JOIN relations r ON r.oid=w.ev_class) AS "tablesSafe",
      (SELECT count(*)=0 FROM routines) AS absent,
      (SELECT count(*)=1 FROM routines) AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN routines p ON p.proname=e.name AND p.proargtypes=e.args LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE p.oid IS NULL OR NOT(p.prokind='f' AND p.prosecdef AND p.prorettype='pg_catalog.void'::regtype AND l.lanname='plpgsql' AND l.lanpltrusted AND p.provolatile='v' AND p.proparallel='u' AND NOT p.proleakproof AND NOT p.proisstrict AND NOT p.proretset AND p.prosrc=e.body AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[] AND p.prosupport=0 AND p.probin IS NULL AND p.prosqlbody IS NULL AND p.procost=100 AND p.prorows=0 AND p.provariadic=0 AND p.pronargdefaults=0 AND p.proallargtypes IS NULL AND p.proargmodes IS NULL AND p.proargnames IS NULL AND p.proargdefaults IS NULL AND p.protrftypes IS NULL)) AS "definitionSafe",
      (SELECT count(DISTINCT proowner)=1 FROM routines) AND EXISTS(SELECT 1 FROM owner o WHERE NOT o.rolcanlogin AND NOT o.rolsuper AND NOT o.rolcreatedb AND NOT o.rolcreaterole AND NOT o.rolreplication AND NOT o.rolbypassrls
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usesysid=o.oid) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=o.oid OR roleid=o.oid)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=o.oid OR(nspname !~ '^pg_' AND nspname<>'information_schema' AND pg_catalog.has_schema_privilege(o.oid,oid,'CREATE')))
        AND EXISTS(SELECT 1 FROM ns WHERE pg_catalog.has_schema_privilege(o.oid,oid,'USAGE')) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba=o.oid)
        AND NOT pg_catalog.has_parameter_privilege(o.oid,'session_replication_role','SET') AND NOT pg_catalog.has_parameter_privilege(o.oid,'session_replication_role','ALTER SYSTEM')
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=o.oid AND NOT EXISTS(SELECT 1 FROM routines f WHERE f.oid=p.oid))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind='S' AND(c.relowner=o.oid OR pg_catalog.has_sequence_privilege(o.oid,c.oid,'USAGE,SELECT,UPDATE')))
        AND NOT EXISTS(SELECT 1 FROM relations r WHERE r.relowner=o.oid OR NOT pg_catalog.has_table_privilege(o.oid,r.oid,'SELECT') OR NOT pg_catalog.has_table_privilege(o.oid,r.oid,'UPDATE'))
        AND NOT EXISTS(SELECT 1 FROM relations r CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(r.relacl,pg_catalog.acldefault('r',r.relowner))) a WHERE a.grantee=o.oid AND a.is_grantable)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN('r','p','v','m','f') AND(c.relowner=o.oid OR pg_catalog.has_table_privilege(o.oid,c.oid,'INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_any_column_privilege(o.oid,c.oid,'INSERT,REFERENCES') OR(NOT EXISTS(SELECT 1 FROM relations r WHERE r.oid=c.oid) AND(pg_catalog.has_table_privilege(o.oid,c.oid,'UPDATE') OR pg_catalog.has_any_column_privilege(o.oid,c.oid,'UPDATE')))))) AS "ownerSafe",
      NOT EXISTS(SELECT 1 FROM routines p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type<>'EXECUTE')) AS "aclSafe",
      (SELECT oid::text FROM owner) AS "ownerOid",COALESCE((SELECT jsonb_agg(oid::text ORDER BY oid) FROM routines),'[]'::jsonb) AS "functionOids"`;
}
export interface CustomerProductCatalog {tablesSafe:boolean;absent:boolean;definitionSafe:boolean;ownerSafe:boolean;aclSafe:boolean;ownerOid:string|null;functionOids:string[]}
export const customerProductCatalogReady=(s:CustomerProductCatalog)=>s.tablesSafe&&!s.absent&&s.definitionSafe&&s.ownerSafe&&s.aclSafe&&s.functionOids.length===1;
const inline=(q:SQL)=>{const r=new PgDialect().sqlToQuery(q.inlineParams());if(r.params.length)throw Error('Customer product catalog installer parameters unresolved');return r.sql;};
const literal=(s:string)=>inline(sql`${s}`);
export function customerProductCatalogLockInstallationSql(schema='public'){
  const s=pricingIdentifier(schema),catalog=inline(customerProductCatalogQuery(schema)),functions=customerProductCatalogBodies(schema),ready=(key:string)=>`${key}->>'tablesSafe'='true' AND ${key}->>'absent'='false' AND ${key}->>'definitionSafe'='true' AND ${key}->>'ownerSafe'='true' AND ${key}->>'aclSafe'='true'`;
  return `DO $customer_product_catalog_install$
DECLARE owner_name text:=nullif(pg_catalog.current_setting('${CUSTOMER_PRODUCT_CATALOG_OWNER_SETTING}',true),'');owner_oid text;ns_oid integer;initial jsonb;locked jsonb;final jsonb;
BEGIN
 IF owner_name IS NULL OR owner_name !~ '^[a-z_][a-z0-9_]{0,62}$' OR pg_catalog.starts_with(owner_name,'pg_') OR owner_name='information_schema' THEN RAISE EXCEPTION 'Customer product catalog requires explicit restricted NOLOGIN owner';END IF;
 IF pg_catalog.current_setting('server_version_num')::int/10000<>16 OR pg_catalog.current_setting('transaction_isolation')<>'read committed' OR pg_catalog.current_setting('transaction_read_only')<>'off' OR pg_catalog.current_setting('session_replication_role')<>'origin' OR EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'Customer product catalog installation requires reviewed PG16 maintenance';END IF;
 SELECT oid::integer INTO ns_oid FROM pg_catalog.pg_namespace WHERE nspname=${literal(schema)};IF ns_oid IS NULL OR NOT pg_catalog.pg_try_advisory_xact_lock(${CUSTOMER_PRODUCT_CATALOG_LOCK_KEY},ns_oid) THEN RAISE EXCEPTION 'Customer product catalog installation busy';END IF;
 SELECT oid::text INTO owner_oid FROM pg_catalog.pg_roles o WHERE rolname=owner_name AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=o.oid OR roleid=o.oid) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usesysid=o.oid) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=o.oid) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba=o.oid) AND NOT pg_catalog.has_schema_privilege(o.oid,${literal(schema)},'CREATE') AND NOT pg_catalog.has_parameter_privilege(o.oid,'session_replication_role','SET') AND NOT pg_catalog.has_parameter_privilege(o.oid,'session_replication_role','ALTER SYSTEM');
 IF owner_oid IS NULL THEN RAISE EXCEPTION 'Customer product catalog owner unsafe';END IF;
 SELECT to_jsonb(q) INTO initial FROM(${catalog})q;IF initial->>'tablesSafe' IS DISTINCT FROM 'true' OR(initial->>'absent' IS DISTINCT FROM 'true' AND(NOT COALESCE((${ready('initial')}),false) OR initial->>'ownerOid' IS DISTINCT FROM owner_oid)) THEN RAISE EXCEPTION 'Customer product catalog catalog owner ACL drift requires review';END IF;
 LOCK TABLE ${CUSTOMER_PRODUCT_CATALOG_RELATIONS.map(t=>`${s}.${pricingIdentifier(t)}`).join(',')} IN ACCESS EXCLUSIVE MODE NOWAIT;
 SELECT to_jsonb(q) INTO locked FROM(${catalog})q;IF locked IS DISTINCT FROM initial THEN RAISE EXCEPTION 'Customer product catalog changed during installation';END IF;
 IF initial->>'absent'='true' THEN
  EXECUTE pg_catalog.format(${literal(`GRANT USAGE,CREATE ON SCHEMA ${s} TO %I`)},owner_name);
  EXECUTE pg_catalog.format(${literal(`GRANT SELECT,UPDATE ON ${CUSTOMER_PRODUCT_CATALOG_RELATIONS.map(t=>`${s}.${pricingIdentifier(t)}`).join(',')} TO %I`)},owner_name);
  ${functions.map(f=>`EXECUTE ${literal(`CREATE FUNCTION ${s}.${f.name}(${f.args}) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $customer_work_lock$${f.body}$customer_work_lock$`)};REVOKE ALL ON FUNCTION ${s}.${f.name}(${f.args}) FROM PUBLIC;EXECUTE pg_catalog.format(${literal(`ALTER FUNCTION ${s}.${f.name}(${f.args}) OWNER TO %I`)},owner_name);`).join('\n  ')}
  EXECUTE pg_catalog.format(${literal(`REVOKE CREATE ON SCHEMA ${s} FROM %I`)},owner_name);
 END IF;
 SELECT to_jsonb(q) INTO final FROM(${catalog})q;IF NOT COALESCE((${ready('final')}),false) OR final->>'ownerOid' IS DISTINCT FROM owner_oid THEN RAISE EXCEPTION 'Customer product catalog final verification failed';END IF;
END $customer_product_catalog_install$;`;
}
