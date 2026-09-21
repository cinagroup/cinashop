import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier, pricingCatalogReady } from './checkoutPricingLockCatalog';
import { inspectCheckoutPricingLock } from './checkoutPricingLock';
import { OFFLINE_STATE_SQL } from './offlineOrderCatalog';
import { INVOICE_EVIDENCE_STATE_SQL } from './invoiceEvidenceCatalog';
import { REFUND_SPLIT_STATE_SQL } from './refundOrderSplitCatalog';
import { inspectAdminRefundOperation } from './runAdminRefundOperation';
import { inspectAdminRefundCreation } from './runAdminRefundCreation';
import { runtimeBusinessPrivilegePlan, RUNTIME_BUSINESS_PRIVILEGES_COMMISSIONING_READY } from './runtimeBusinessPrivilegePlan';
import { runtimeBusinessGrantSql, type RuntimeOwnedSequence } from './runtimeBusinessGrantSql';
import { installRuntimeAdminBoundaryInTransaction } from './runtimeAdminBoundary';
import { installRuntimeLockOnlyBoundaryInTransaction } from './runtimeLockOnlyBoundary';
import { inspectShippingTemplateCreateReplay } from './runShippingTemplateCreateReplay';
import { SHIPPING_CREATE_REPLAY_INSTALLATION_SQL } from './shippingTemplateCreateReplayInstallation';

type Query=Pick<DbClient,'execute'>;
export interface RuntimeCommissionTarget {database:string;maintenance:string;app:string;admin:string;pricingOwner:string}
export const RUNTIME_COMMISSION_OPERATION='isolated-business-runtime-v1';
export const RUNTIME_SHIPPING_OPERATION='shipping-replay-schema-0154-v1';
function validate(target:RuntimeCommissionTarget){
  Object.values(target).forEach(pricingIdentifier);
  if(new Set([target.maintenance,target.app,target.admin,target.pricingOwner]).size!==4)throw Error('Distinct runtime identities required');
}
async function setup(tx:Query,target:RuntimeCommissionTarget){
  validate(target);
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),set_config('statement_timeout','5000',true),
    set_config('lock_timeout','1000',true),set_config('idle_in_transaction_session_timeout','5000',true)`);
  const [row]=await tx.execute(sql`SELECT current_database()=${target.database} AND current_user=${target.maintenance}
    AND session_user=current_user AND current_setting('server_version_num')::int/10000=16
    AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
      WHERE a.pid=pg_backend_pid() AND r.rolname=current_user AND r.rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported`);
  if(row?.supported!==true)throw Error('Runtime commissioning target requires review');
}
async function inspect(tx:Query,target:RuntimeCommissionTarget){
  const roles=await tx.execute(sql`SELECT r.rolname AS name,r.rolcanlogin
    AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
    AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND has_schema_privilege(r.oid,n.oid,'CREATE'))
    AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM') AS restricted,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND CASE
      WHEN c.relkind='S' THEN pg_catalog.has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE')
      WHEN c.relkind IN('r','p','v','m','f') THEN pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') ELSE false END) AS empty,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND p.prosecdef
        AND pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE')) AS no_definer,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
      WHERE a.grantee=r.oid OR (a.grantee=0 AND d.defaclobjtype IN('r','S'))) AS no_default_grants
    FROM pg_catalog.pg_roles r WHERE rolname IN (${target.app},${target.admin}) ORDER BY rolname`);
  const tables=[...new Set([...Object.keys(runtimeBusinessPrivilegePlan('app').tables),...Object.keys(runtimeBusinessPrivilegePlan('admin').tables)])].sort();
  const catalog=await tx.execute(sql`SELECT c.relname AS name,c.relkind AS kind,pg_catalog.pg_get_userbyid(c.relowner) AS owner,
    c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
    AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${target.maintenance})
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid) AS ordinary
    FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN (${sql.join(tables.map(t=>sql`${t}`),sql`, `)})`);
  const sequences=await tx.execute(sql`SELECT s.relname AS name,t.relname AS table,
    s.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${target.maintenance}) AND s.relpersistence='p' AS ordinary
    FROM pg_catalog.pg_class s JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_class'::regclass AND d.objid=s.oid
      AND d.refclassid=d.classid AND d.deptype IN('a','i')
    JOIN pg_catalog.pg_class t ON t.oid=d.refobjid AND t.relnamespace=s.relnamespace
    WHERE s.relnamespace='public'::regnamespace AND s.relkind='S'
      AND t.relname IN (${sql.join(tables.map(t=>sql`${t}`),sql`, `)})`);
  const [standalone]=await tx.execute(sql`SELECT count(*)=1 AND bool_and(relkind='S' AND relpersistence='p'
    AND relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${target.maintenance})) AS ready
    FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND relname='kefu_visitor_uid_seq'`);
  const pricing=await inspectCheckoutPricingLock(tx),[owner]=await tx.execute(sql`SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname=${target.pricingOwner}`);
  const [offline]=await tx.execute(sql.raw(OFFLINE_STATE_SQL));
  const [invoice]=await tx.execute(sql.raw(INVOICE_EVIDENCE_STATE_SQL)),[refund]=await tx.execute(sql.raw(REFUND_SPLIT_STATE_SQL));
  const operation=await inspectAdminRefundOperation(tx),creation=await inspectAdminRefundCreation(tx);
  const shippingReplay=await inspectShippingTemplateCreateReplay(tx);
  return {roles:Array.from(roles),tablesReady:catalog.length===tables.length && catalog.every(r=>r.ordinary===true),
    missingTables:tables.filter(t=>!catalog.some(r=>r.name===t)),
    nonordinaryTables:catalog.filter(r=>r.ordinary!==true).map(r=>({name:r.name,kind:r.kind,owner:r.owner})),
    sequencesReady:sequences.every(r=>r.ordinary===true) && standalone?.ready===true,
    pricingReady:pricingCatalogReady(pricing) && pricing.ownerOid===owner?.oid,offlineReady:offline?.state==='v1',
    refundProtocolsReady:invoice?.state==='v2' && refund?.state==='v1' && operation.complete && creation.complete,
    shippingReplay,
    ownedSequences:sequences.map(r=>({name:String(r.name),table:String(r.table)})) satisfies RuntimeOwnedSequence[]};
}
/** Separately authorized schema prerequisite only: exact existing external
 * 0154 installer, no business rows, GRANTs, credential changes or runAll. */
export async function runRuntimeShippingPrerequisite(db:DbClient,target:RuntimeCommissionTarget){
  if(!Object.hasOwn(db,'$client'))throw Error('Root schema connection required');
  return db.transaction(async tx=>{
    await setup(tx,target);
    const before=await inspectShippingTemplateCreateReplay(tx);
    await tx.execute(sql.raw(SHIPPING_CREATE_REPLAY_INSTALLATION_SQL));
    const after=await inspectShippingTemplateCreateReplay(tx);
    if(!after.complete)throw Error('Shipping prerequisite verification failed');
    return {operation:RUNTIME_SHIPPING_OPERATION,applied:!before.present,before,after,businessGrantsApplied:false as const};
  },{isolationLevel:'read committed',accessMode:'read write'});
}
export async function inspectRuntimeBusinessCommissioning(db:DbClient,target:RuntimeCommissionTarget){
  if(!Object.hasOwn(db,'$client'))throw Error('Root commissioning connection required');
  return db.transaction(async tx=>{await setup(tx,target);const result=await inspect(tx,target);
    return {operation:RUNTIME_COMMISSION_OPERATION,...result,applyEnabled:RUNTIME_BUSINESS_PRIVILEGES_COMMISSIONING_READY};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}
/** Internal fixed transaction component: also tested against fresh, owned
 * PG16 fixtures. No caller-chosen plan, new roles, passwords or data writes.
 * Existing grants or second invocation refuse; never repair/revoke in place. */
export async function installRuntimeBusinessInTransaction(tx:Query,target:RuntimeCommissionTarget){
  if(Object.hasOwn(tx,'$client'))throw Error('Existing commissioning transaction required');
  await setup(tx,target);
  const [gate]=await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731625,2) AS locked`);
  if(gate?.locked!==true)throw Error('Runtime commissioning is busy');
  const state=await inspect(tx,target);
  if(state.roles.length!==2 || state.roles.some(r=>r.restricted!==true || r.empty!==true || r.no_definer!==true || r.no_default_grants!==true)
    || !state.tablesReady || !state.sequencesReady || !state.pricingReady || !state.offlineReady || !state.refundProtocolsReady || !state.shippingReplay.complete)
    throw Error('Runtime commissioning preflight refused; inspect existing authority and protocol');
  await installRuntimeAdminBoundaryInTransaction(tx,target.app,target.maintenance);
  await installRuntimeLockOnlyBoundaryInTransaction(tx,target.app,target.admin,target.maintenance);
  for(const kind of ['app','admin'] as const)
    for(const statement of runtimeBusinessGrantSql(kind,target[kind],state.ownedSequences))await tx.execute(sql.raw(statement));
  return {operation:RUNTIME_COMMISSION_OPERATION,grantsApplied:true as const,businessValidationRequired:true as const};
}
export async function runRuntimeBusinessCommissioning(db:DbClient,target:RuntimeCommissionTarget){
  if(!RUNTIME_BUSINESS_PRIVILEGES_COMMISSIONING_READY)throw Error('Runtime profile is still a draft; commissioning disabled');
  if(!Object.hasOwn(db,'$client'))throw Error('Root commissioning connection required');
  return db.transaction(tx=>installRuntimeBusinessInTransaction(tx,target),{isolationLevel:'read committed',accessMode:'read write'});
}
