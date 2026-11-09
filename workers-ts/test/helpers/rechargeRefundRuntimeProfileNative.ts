/** Real registered full-profile fixture only. No new runtime LOGIN, business
 * grant, payment MAC, paid recharge, refund hold or provider operation is seeded.
 * The importer reaches the existing fixed-role AST scheduling roots. */
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DbClient } from '@/lib/di';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from '@/migrations/customerFinancialRuntimePlan';
import { MANAGER_RUNTIME_ROLE } from '@/migrations/managerRuntimePrivilegePlan';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { runRoutineRefundUpgrade } from '@/migrations/runRoutineRefundUpgrade';
import { upgradeCustomerFinancialRoutineRefund } from '@/migrations/upgradeCustomerFinancialRoutineRefund';
import { runRechargeRefundInstallation, type RechargeRefundBinding } from '@/migrations/rechargeRefund';
import { inspectRoutineRefundCatalog } from '@/migrations/routineRefund';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { auditCustomerFinancialRuntimePrivileges } from '@/migrations/auditCustomerFinancialRuntimePrivileges';
import { auditManagerRuntimePrivileges } from '@/migrations/auditManagerRuntimePrivileges';
import { auditCustomerCashierSecondCardRuntimePrivileges } from '@/migrations/auditCustomerCashierSecondCardRuntimePrivileges';
import { upgradeRechargeRefundRuntimeProfiles, type RechargeRefundRuntimeProfileInput } from '@/migrations/upgradeRechargeRefundRuntimeProfiles';
import type { RuntimeGiftPeerDeclarations } from '@/migrations/customerRuntimeGiftPeers';
import { customerCashierRuntimeHttpFixture } from './customerCashierRuntimeHttpFixture';

export const rechargeProfileKinds=['app','admin','financial','manager','cashier'] as const;
export type RechargeProfileKind=typeof rechargeProfileKinds[number];
const sourceTables=['routine_original_payment_evidence','routine_payment_account_policy','routine_payment_account_use'];
const newTables=['recharge_refund_operation','recharge_refund_state','recharge_refund_attempt','recharge_refund_result',
 'recharge_routine_refund_account_policy'];
const newFunctions=['recharge_refund_valid_v1','recharge_refund_guard_v1','recharge_refund_lock_source_v1',
 'recharge_routine_refund_account_immutable_v1'];
const addon=Object.freeze({rechargeRefund:true as const});
const canonical=(value:unknown)=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)
 ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);

export async function rechargeRefundRuntimeProfileFixture(withGoods=false) {
 const f=await customerCashierRuntimeHttpFixture();
 try {
  let beforePeers:RuntimeGiftPeerDeclarations=f.peers;
  await runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb,f.target,beforePeers,f.appReaders);
  await runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb,f.target,beforePeers,f.appReaders);
  let goods:RechargeRefundRuntimeProfileInput['goods'];
  if(withGoods) {
   await runRoutineRefundUpgrade(f.maintenanceDb,f.target,beforePeers,f.appReaders);
   const old=await upgradeCustomerFinancialRoutineRefund(f.maintenanceDb,f.target,
    {routineRefund:{routineRefund:true},manualRefund:f.manual,originalPaymentReaders:f.readers},beforePeers,f.appReaders);
   if(!old.applied)throw Error('Fresh formal goods Financial predecessor must advance');
   beforePeers=old.peers;
   const observed=await inspectRoutineRefundCatalog(f.maintenanceDb);
   if(!observed.ready||!observed.binding||observed.binding.financial!==CUSTOMER_FINANCIAL_RUNTIME_ROLE)
    throw Error('Complete independent goods Financial predecessor required');
   // No names projection; this complete binding is later compared exactly.
   goods=Object.freeze({...observed.binding});
  }
  await runRechargeRefundInstallation(f.maintenanceDb);
  const peers={app:f.appRuntime,admin:f.adminRuntime,financial:f.financialRuntime,manager:f.managerRuntime,cashier:f.cashierRuntime};
  const identities={} as Record<RechargeProfileKind,{role:string;session:string;backend:string;oid:string;pid:number;database:string}>;
  for(const kind of rechargeProfileKinds) {
   const [r]=await peers[kind].db.execute<{role:string;session:string;backend:string;oid:string;pid:number;database:string}>(sql`SELECT
    current_user AS role,session_user AS session,(SELECT pg_catalog.pg_get_userbyid(usesysid) FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid()) AS backend,
    (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=current_user) AS oid,pg_backend_pid() AS pid,current_database() AS database`);
   if(!r||r.role!==peers[kind].role||r.session!==r.role||r.backend!==r.role||r.database!==f.target.database)
    throw Error('Actual full-profile LOGIN/session/backend differs: '+kind);
   identities[kind]=r;
  }
  const [owner]=await f.maintenanceDb.execute<{role:string;oid:string;database:string;databaseOid:string;pid:number;safe:boolean}>(sql`SELECT
   current_user AS role,(SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=current_user) AS oid,current_database() AS database,
   (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS "databaseOid",pg_backend_pid() AS pid,
   current_user=session_user AND current_user='finance_test' AND current_setting('server_version_num')::integer/10000=16 AS safe`);
  if(!owner?.safe||identities.financial.role!==CUSTOMER_FINANCIAL_RUNTIME_ROLE||identities.manager.role!==MANAGER_RUNTIME_ROLE
   ||new Set([owner.pid,...Object.values(identities).map(r=>r.pid)]).size!==6)throw Error('Actual six independent owner/five-profile PIDs required');
  const binding:RechargeRefundBinding={database:owner.database,databaseOid:owner.databaseOid,maintenance:owner.role,maintenanceOid:owner.oid,
   app:identities.app.role,appOid:identities.app.oid,admin:identities.admin.role,adminOid:identities.admin.oid,
   financial:identities.financial.role,financialOid:identities.financial.oid,manager:identities.manager.role,managerOid:identities.manager.oid};
  const afterPeers:RuntimeGiftPeerDeclarations={...beforePeers,rechargeRefund:addon};
  const input:RechargeRefundRuntimeProfileInput={binding,target:f.target,addon,peers:afterPeers,appReader:f.appReaders,...(goods?{goods}:{})};
  const audit=async(kind:RechargeProfileKind,successor:boolean)=>{
   const p=successor?afterPeers:beforePeers;
   if(kind==='app'||kind==='admin')return auditRuntimeBusinessPrivileges(peers[kind].db,kind,f.target,undefined,p,kind==='app'?f.appReaders:undefined);
   if(kind==='financial')return auditCustomerFinancialRuntimePrivileges(peers.financial.db,f.target,f.manual,f.readers,
    beforePeers.financial?.routineRefund,successor?addon:undefined);
   if(kind==='manager')return auditManagerRuntimePrivileges(peers.manager.db,f.target,
    beforePeers.routineRefundActors?.manager?true:undefined,beforePeers.cityConflictReaders,
    beforePeers.fulfillmentAssignments,beforePeers.managerAssignedWholeExpress);
   const cashier=beforePeers.cashierSecondCard!;
   return auditCustomerCashierSecondCardRuntimePrivileges(peers.cashier.db,peers.cashier.role,f.target,
    {abandon:true,...(cashier.conditionalGuards?{conditionalGuards:true}:{}),...(cashier.formImages?{formImages:true}:{})});
  };
  // The established full-factory setup budget includes actual predecessor
  // acceptance; no test author/provider action is hidden in setup.
  const beforeAudits={} as Record<RechargeProfileKind,Awaited<ReturnType<typeof audit>>>;
  for(const kind of rechargeProfileKinds) {
   beforeAudits[kind]=await audit(kind,false);
   if(!beforeAudits[kind].ready)throw Error('Complete actual predecessor refused: '+kind+':'+beforeAudits[kind].failures.join(','));
  }
  return{...f,profilePeers:peers,binding,input,identities,owner,beforePeers,afterPeers,beforeAudits,audit,
   commission:(root:DbClient=f.maintenanceDb,override:RechargeRefundRuntimeProfileInput=input)=>upgradeRechargeRefundRuntimeProfiles(root,override)};
 }catch(error){await f.close();throw error;}
}
export type RechargeRefundRuntimeProfileFixture=Awaited<ReturnType<typeof rechargeRefundRuntimeProfileFixture>>;

/** Every pre-existing public business data ACL, column ACL, sequence ACL and
 * routine ACL. Exclude only precisely named source SELECT deltas and new objects.
 * No server-read grants contribute to an authority plan. */
export async function rechargeProfileOldBusinessAcl(db:DbClient):Promise<string> {
 const [r]=await db.execute<{value:unknown}>(sql`SELECT jsonb_build_object(
  'classes',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.oid::text,c.relowner::text,c.relacl,
   (SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attname,a.attacl) ORDER BY a.attnum)
    FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0)) ORDER BY c.relname COLLATE "C")
   FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v','m','f','S')
    AND c.relname NOT IN(${sql.join([...sourceTables,...newTables].map(t=>sql`${t}`),sql`,`)})),
  'source_columns',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relowner::text,
    (SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attname,a.attacl) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0))
    ORDER BY c.relname COLLATE "C") FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace
    AND c.relname IN(${sql.join(sourceTables.map(t=>sql`${t}`),sql`,`)})),
  'routines',(SELECT jsonb_agg(jsonb_build_array(p.oid::text,p.proname,p.proargtypes::text,p.proowner::text,p.proacl)
    ORDER BY p.oid) FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
    AND p.proname NOT IN(${sql.join(newFunctions.map(t=>sql`${t}`),sql`,`)}))) AS value`);
 return canonical(r.value);
}

/** Only effective positive privileges are included. Creating a new object to
 * which Manager/Cashier has zero rights cannot manufacture a harmless delta. */
export async function rechargeProfileEffectivePrivileges(db:DbClient,role:string):Promise<string> {
 const [r]=await db.execute<{value:unknown}>(sql`SELECT jsonb_build_object(
  'data',(SELECT jsonb_agg(to_jsonb(x) ORDER BY name COLLATE "C",privilege COLLATE "C") FROM(
    SELECT c.relname AS name,p.privilege FROM pg_catalog.pg_class c CROSS JOIN
     (VALUES('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege)
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v','m','f')
     AND pg_catalog.has_table_privilege(${role},c.oid,p.privilege)) x),
  'columns',(SELECT jsonb_agg(to_jsonb(x) ORDER BY name COLLATE "C",column_name COLLATE "C",privilege COLLATE "C") FROM(
    SELECT c.relname AS name,a.attname AS column_name,p.privilege FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
    CROSS JOIN(VALUES('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(privilege)
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v','m','f') AND NOT a.attisdropped
     AND pg_catalog.has_column_privilege(${role},c.oid,a.attnum,p.privilege)) x),
  'sequences',(SELECT jsonb_agg(to_jsonb(x) ORDER BY name COLLATE "C",privilege COLLATE "C") FROM(
    SELECT c.relname AS name,p.privilege FROM pg_catalog.pg_class c CROSS JOIN(VALUES('USAGE'),('SELECT'),('UPDATE')) p(privilege)
    WHERE c.relnamespace='public'::regnamespace AND c.relkind='S' AND pg_catalog.has_sequence_privilege(${role},c.oid,p.privilege)) x),
  'routines',(SELECT jsonb_agg(jsonb_build_array(p.oid::text,p.proname,p.proargtypes::text) ORDER BY p.oid)
    FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND pg_catalog.has_function_privilege(${role},p.oid,'EXECUTE'))) AS value`);
 return canonical(r.value);
}

/** Catalog tuple/ACL/body/binding and real business/source rows, including
 * relation/data xmin, for exact replay/rollback assertions. Account absence is
 * observed before referencing that relation: no missing-table planner fallback. */
export async function rechargeProfileSnapshot(db:DbClient):Promise<string> {
 const [r]=await db.execute<{value:unknown;account:boolean}>(sql`SELECT jsonb_build_object(
  'classes',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(c),c.xmin::text,obj_description(c.oid,'pg_class'),
    (SELECT jsonb_agg(jsonb_build_array(to_jsonb(a),a.xmin::text) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0),
    (SELECT jsonb_agg(jsonb_build_array(to_jsonb(k),k.xmin::text) ORDER BY k.oid) FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid),
    (SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY t.oid) FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid))
    ORDER BY c.relname COLLATE "C") FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace
    AND (c.relname IN(${sql.join([...sourceTables,...newTables].map(t=>sql`${t}`),sql`,`)}) OR c.relname~'^(rcro_|rcra_|rcrr_|rcrs_|crra_)')),
  'functions',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(p),p.xmin::text,obj_description(p.oid,'pg_proc')) ORDER BY p.oid)
    FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN(${sql.join(newFunctions.map(t=>sql`${t}`),sql`,`)})),
  'original',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY evidence_id) FROM public.routine_original_payment_evidence t),
  'account_history',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY record_id) FROM public.routine_payment_account_policy t),
  'use_history',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY use_id) FROM public.routine_payment_account_use t),
  'operation',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY operation_id) FROM public.recharge_refund_operation t),
  'state',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY operation_id) FROM public.recharge_refund_state t),
  'attempt',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY attempt_id) FROM public.recharge_refund_attempt t),
  'result',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY result_id) FROM public.recharge_refund_result t),
  'wallet',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY uid) FROM public."user" t),
  'recharge',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.user_recharge t),
  'bills',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.user_bill t),
  'events',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.store_order_outbox t)) AS value,
  pg_catalog.to_regclass('public.recharge_routine_refund_account_policy') IS NOT NULL AS account`);
 const account=r.account?await db.execute(sql`SELECT to_jsonb(t) AS row,xmin::text AS xmin FROM public.recharge_routine_refund_account_policy t ORDER BY record_id`):null;
 return canonical({facts:r.value,account});
}

/** Observe actual dispatched SQL and inject only at the real owning root
 * transaction boundary. No catalog, role, function, result or SQL is mocked. */
export function observeRechargeProfileRoot(owner:DbClient,after?:(tx:DbClient)=>Promise<void>) {
 const mutations:string[]=[],dialect=new PgDialect(),transaction=owner.transaction.bind(owner);
 const db=new Proxy(owner,{get(target,key,receiver){
  if(key!=='transaction')return Reflect.get(target,key,receiver);
  return(callback:(tx:DbClient)=>Promise<unknown>,config:Parameters<DbClient['transaction']>[1])=>transaction(async actual=>{
   const tx=actual as unknown as DbClient,observed=new Proxy(tx,{get(inner,field,source){
    if(field!=='execute')return Reflect.get(inner,field,source);
    return(statement:SQL)=>{const text=dialect.sqlToQuery(statement).sql;
     if(/^\s*(GRANT|COMMENT|CREATE|ALTER|REVOKE|DROP|INSERT|UPDATE|DELETE|TRUNCATE)\b/u.test(text))mutations.push(text);
     return inner.execute(statement);};
   }});
   const result=await callback(observed);await after?.(tx);return result;
  },config);
 }});
 return{db,mutations};
}
