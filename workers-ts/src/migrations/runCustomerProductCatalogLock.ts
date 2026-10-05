import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { CUSTOMER_PRODUCT_CATALOG_LOCK_KEY,CUSTOMER_PRODUCT_CATALOG_OWNER_SETTING,customerProductCatalogQuery,customerProductCatalogReady,customerProductCatalogLockInstallationSql,type CustomerProductCatalog } from './customerProductCatalogLock';
type Query=Pick<DbClient,'execute'>;
export async function inspectCustomerProductCatalogLock(db:Query,schema='public'):Promise<CustomerProductCatalog> {
 const[row]=await db.execute(customerProductCatalogQuery(schema));
 if(!row)throw Error('Customer product catalog unavailable');
 return{tablesSafe:row.tablesSafe===true,absent:row.absent===true,definitionSafe:row.definitionSafe===true,ownerSafe:row.ownerSafe===true,aclSafe:row.aclSafe===true,ownerOid:typeof row.ownerOid==='string'?row.ownerOid:null,functionOids:Array.isArray(row.functionOids)?row.functionOids.filter((v):v is string=>typeof v==='string'):[]};
}
export async function installCustomerProductCatalogLock(db:Pick<DbClient,'transaction'>&Partial<Pick<DbClient,'$client'>>,ownerRole:string,schema='public') {
 if(!Object.hasOwn(db,'$client')||!db.$client)throw Error('Customer product catalog installation requires root maintenance client');
 pricingIdentifier(ownerRole);pricingIdentifier(schema);
 return db.transaction(async tx=>{
  await tx.execute(sql`SELECT pg_catalog.set_config(${CUSTOMER_PRODUCT_CATALOG_OWNER_SETTING},${ownerRole},true)`);
  await tx.execute(sql.raw(customerProductCatalogLockInstallationSql(schema)));
  const state=await inspectCustomerProductCatalogLock(tx,schema);
  if(!customerProductCatalogReady(state))throw Error('Customer product catalog installation failed verification');
  return state;
 },{isolationLevel:'read committed',accessMode:'read write'});
}
/** Inspection only. Even an inherited column UPDATE grant on a taxonomy is
 * incompatible with the runtime's read/lock-only capability. */
export async function customerProductCatalogLockReadiness(db:Query,schema='public') {
 const catalog=await inspectCustomerProductCatalogLock(db,schema);
 if(!customerProductCatalogReady(catalog))return{ready:false,reason:catalog.absent?'customer_product_catalog_lock_not_installed':'customer_product_catalog_lock_unreviewed',catalog};
 const[row]=await db.execute(sql`
 WITH RECURSIVE identity AS(SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN(current_user,session_user)
  UNION SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()),
 authority(oid) AS(SELECT oid FROM identity UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN authority a ON a.oid=m.member)
 SELECT NOT EXISTS(SELECT 1 FROM authority a JOIN pg_catalog.pg_roles r ON r.oid=a.oid WHERE
  r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.oid::text=${catalog.ownerOid}
  OR pg_catalog.has_schema_privilege(r.oid,${schema},'CREATE')
  OR pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba=r.oid AND datname=current_database())
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname=${schema} AND c.relname IN('store_product_category','store_product_label','category')
   AND(c.relowner=r.oid OR pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES')))) AS safe,
 (SELECT count(*)=3 AND bool_and(pg_catalog.has_table_privilege(current_user,c.oid,'SELECT'))
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname=${schema} AND c.relname IN('store_product_category','store_product_label','category')) AS readable,
 (SELECT count(*)=1 AND bool_and(pg_catalog.has_function_privilege(current_user,oid,'EXECUTE'))
  FROM pg_catalog.pg_proc WHERE oid::text IN(${sql.join(catalog.functionOids.map(id=>sql`${id}`),sql`, `)})) AS executable`);
 const ready=row?.safe===true&&row?.readable===true&&row?.executable===true;
 return{ready,reason:ready?'':'customer_product_catalog_runtime_unreviewed',catalog};
}
export async function acquireCustomerProductCatalogLock(tx:DbClient,kind:'category'|'label',ids:readonly number[],schema='public') {
 if(Object.hasOwn(tx,'$client'))throw Error('Customer product catalog locks require caller-owned transaction');
 if(!['category','label'].includes(kind)||ids.length>100||ids.some((id,i)=>!Number.isSafeInteger(id)||id<1||id>2147483647||(i>0&&id<=ids[i-1]!)))
  throw Error('Customer product catalog targets invalid');
 const[row]=await tx.execute(sql`SELECT pg_catalog.pg_try_advisory_xact_lock_shared(${CUSTOMER_PRODUCT_CATALOG_LOCK_KEY},oid::int) AS locked FROM pg_catalog.pg_namespace WHERE nspname=${schema}`);
 if(row?.locked!==true)throw Error('Customer product catalog maintenance busy');
 if(!(await customerProductCatalogLockReadiness(tx,schema)).ready)throw Error('Customer product catalog lock capability missing or unreviewed');
 const literal=ids.length?sql`ARRAY[${sql.join(ids.map(id=>sql`${id}`),sql`, `)}]::integer[]`:sql`ARRAY[]::integer[]`;
 await tx.execute(sql`SELECT ${sql.raw(pricingIdentifier(schema))}.customer_product_lock_catalog_v1(${kind}::text,${literal})`);
}
