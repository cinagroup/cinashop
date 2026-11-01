import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRoutinePaymentRuntime, type RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';
import { inspectRoutineRefundCatalog } from './routineRefund';
import { inspectRoutineOriginalPaymentEvidenceCatalog } from './routineOriginalPaymentEvidence';
import { inspectRoutinePaymentAccountPolicyCatalog } from './routinePaymentAccountPolicy';
import { inspectRoutineRefundActorPrincipals } from './routineRefundActorPrincipals';
import { captureRoutineRefundActorAddons, ROUTINE_REFUND_ACTOR_TABLE_PRIVILEGES, type RoutineRefundActorAddons } from './routineRefundActorAddon';
import { captureRuntimeGiftPeerDeclarations, type RuntimeGiftPeerDeclarations } from './customerRuntimeGiftPeers';
import { captureRuntimeAppCashierOriginReader, type RuntimeAppCashierOriginReaderAddon } from './runtimeAppCashierOriginReader';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { inspectManagerRuntimePrivileges } from './auditManagerRuntimePrivileges';
import { MANAGER_RUNTIME_ROLE } from './managerRuntimePrivilegePlan';

type Query=Pick<DbClient,'execute'>;
export interface RoutineRefundActorsDeclaration {actors:RoutineRefundActorAddons;previousActors?:RoutineRefundActorAddons}
export const ROUTINE_REFUND_ACTORS_UPGRADE='routine-refund-actors-v1';
const equal=(a:RoutineRefundActorAddons|undefined,b:RoutineRefundActorAddons|undefined)=>!!a?.admin===!!b?.admin&&!!a?.manager===!!b?.manager;

/** Maintenance declarations contain only bounded plain data. Copy first, so
 * neither accessors/coercion nor an asynchronous BEGIN can change the intent. */
function snapshot<T>(value:T):T {
 let nodes=0,bytes=0;
 const copy=(v:unknown,depth:number):unknown=>{
  if(++nodes>256||depth>8)throw Error('Bounded plain refund declaration required');
  if(v===null||v===undefined||typeof v==='boolean')return v;
  if(typeof v==='string'){bytes+=v.length;if(v.length>1024||bytes>65536)throw Error('Bounded refund declaration strings required');return v;}
  if(typeof v==='number'&&Number.isSafeInteger(v))return v;
  if(!v||typeof v!=='object'||(Array.isArray(v)?Object.getPrototypeOf(v)!==Array.prototype:
   ![Object.prototype,null].includes(Object.getPrototypeOf(v))))throw Error('Primitive refund declaration fields required');
  const ds=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(v);
  if(Array.isArray(v)){
   if(v.length>32||keys.length!==v.length+1||keys.some(k=>typeof k!=='string'||k!=='length'&&(!/^(0|[1-9][0-9]*)$/u.test(k)||Number(k)>=v.length)))
    throw Error('Dense bounded refund declaration arrays required');
   return Array.from({length:v.length},(_,i)=>{const d=ds[String(i)];if(!d?.enumerable||!('value'in d))throw Error('Plain refund declaration array required');return copy(d.value,depth+1);});
  }
  const result:Record<string,unknown>=Object.create(null);
  for(const k of keys){if(typeof k!=='string'||!ds[k]?.enumerable||!('value'in ds[k]))throw Error('Data-only refund declaration required');result[k]=copy(ds[k].value,depth+1);}
  return result;
 };
 return copy(value,0) as T;
}
function capture(target:RoutinePaymentRuntimeTarget,input:RoutineRefundActorsDeclaration,
 peers:RuntimeGiftPeerDeclarations,reader?:RuntimeAppCashierOriginReaderAddon){
 const raw=snapshot({target,input,peers,...(reader===undefined?{}:{reader})}),t=raw.target;
 if(!t||typeof t!=='object'||Array.isArray(t))throw Error('Explicit refund actor target required');
 const identity=(v:unknown):string=>{if(typeof v!=='string')throw Error('Primitive refund actor identity required');pricingIdentifier(v);return v;};
 const local=t.local===undefined?undefined:t.local;
 if(local!==undefined&&(!Array.isArray(local)||local.length>16))throw Error('Bounded explicit refund actor local identities required');
 const captured:RoutinePaymentRuntimeTarget={database:identity(t.database),maintenance:identity(t.maintenance),app:identity(t.app),admin:identity(t.admin),
  ...(local?{local:local.map(identity)}:{}),...(t.caseLock?{caseLock:{owner:identity(t.caseLock.owner),runtimeRoles:t.caseLock.runtimeRoles.map(identity)}}:{})};
 const identities=[captured.maintenance,captured.app,captured.admin,...(captured.local??[])];
 if(new Set(identities).size!==identities.length)throw Error('Distinct refund actor identities required');
 if(captured.caseLock&&(!captured.caseLock.runtimeRoles.length||captured.caseLock.runtimeRoles.length>16
  ||identities.includes(captured.caseLock.owner)||new Set(captured.caseLock.runtimeRoles).size!==captured.caseLock.runtimeRoles.length
  ||captured.caseLock.runtimeRoles.some(n=>!captured.local?.includes(n))))throw Error('Exact local refund actor case-lock required');
 const i=raw.input;
 if(!i||typeof i!=='object'||Array.isArray(i)||Reflect.ownKeys(i).some(k=>typeof k!=='string'||!['actors','previousActors'].includes(k)))
  throw Error('Exact refund actor forward declaration required');
 const actors=captureRoutineRefundActorAddons(i.actors),previous=i.previousActors===undefined?undefined:captureRoutineRefundActorAddons(i.previousActors);
 if(previous?.admin&&!actors.admin||previous?.manager&&!actors.manager)throw Error('Refund actor forward cannot remove an existing actor');
 const afterPeers=captureRuntimeGiftPeerDeclarations(raw.peers);
 const binding=(v:RoutinePaymentRuntimeTarget)=>JSON.stringify([v.database,v.maintenance,v.app,v.admin,[...(v.local??[])].sort(),
  v.caseLock?[v.caseLock.owner,[...v.caseLock.runtimeRoles].sort()]:null]);
 if(binding(captured)!==binding(afterPeers.target)||!equal(actors,afterPeers.routineRefundActors))throw Error('Exact complete successor refund actor peers required');
 if(actors.manager&&(!afterPeers.manager||!captured.local?.includes(MANAGER_RUNTIME_ROLE)))throw Error('Explicit complete Manager refund peer required');
 const{routineRefundActors:_,...basePeers}=afterPeers;
 const beforePeers:RuntimeGiftPeerDeclarations={...basePeers,...(previous?{routineRefundActors:previous}:{})};
 return{target:captured,actors,previous,beforePeers,afterPeers,reader:raw.reader===undefined?undefined:captureRuntimeAppCashierOriginReader(raw.reader)};
}

/** Explicit six-table ACL forward. It creates no role or schema object and
 * adopts no account/payment history. Partial/drifted states are never repaired. */
export async function upgradeRoutineRefundActorsInTransaction(tx:Query,target:RoutinePaymentRuntimeTarget,input:RoutineRefundActorsDeclaration,
 peers:RuntimeGiftPeerDeclarations,reader?:RuntimeAppCashierOriginReaderAddon){
 if(Object.hasOwn(tx,'$client'))throw Error('Caller-owned refund actor maintenance transaction required');
 const c=capture(target,input,peers,reader),t=c.target;
 await tx.execute(sql`SELECT pg_catalog.set_config('search_path','public,pg_temp',true),
  pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
  pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
  pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
 const[id]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.current_database()=${t.database} AND current_user=${t.maintenance}
  AND current_user=session_user AND pg_catalog.current_schema()='public' AND r.rolcanlogin AND r.rolsuper
  AND r.oid=(SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid())
  AND pg_catalog.current_setting('server_version_num')::integer/10000=16
  AND pg_catalog.current_setting('transaction_isolation')='read committed' AND pg_catalog.current_setting('transaction_read_only')='off'
  AND pg_catalog.current_setting('session_replication_role')='origin'
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS ready
  FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
 if(id?.ready!==true)throw Error('Actual PG16 refund actor maintenance LOGIN/database required');
 // Union of the existing source, current App/Admin boundary and Manager
 // provision prefixes. All gates are try-only and precede physical resources.
 for(const[k,s]of[[731669,0],[731670,0],[731625,2],[731624,0],[731685,0],[731812,1],[731714,0],[731717,0],[731718,0]]){
  const[g]=await tx.execute<{locked:boolean}>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(${k},${s}) AS locked`);
  if(g?.locked!==true)throw Error('Routine refund actor commissioning is busy');
 }
 const tables=[...Object.keys(ROUTINE_REFUND_ACTOR_TABLE_PRIVILEGES),...(c.actors.admin?['admin_refund_operation']:[]),
  ...(c.actors.manager?['manager_order_operation_request']:[])].sort();
 await tx.execute(sql.raw('LOCK TABLE '+tables.map(n=>'ONLY public.'+pricingIdentifier(n)).join(',')+' IN ACCESS EXCLUSIVE MODE NOWAIT'));
 const named=await inspectRoutineRefundActorPrincipals(tx,{maintenance:t.maintenance,app:t.app,admin:t.admin});
 if(!named.ready||c.actors.manager&&named.binding?.manager!==MANAGER_RUNTIME_ROLE)throw Error('Canonical refund actor principal proof required');
 if(!(await inspectRoutinePaymentRuntime(tx,t)).ready)throw Error('Existing refund actor Routine binding required');
 const catalog=await inspectRoutineRefundCatalog(tx,t),b=catalog.binding;
 if(!catalog.ready||!b||!(await inspectRoutineOriginalPaymentEvidenceCatalog(tx,t)).ready||!(await inspectRoutinePaymentAccountPolicyCatalog(tx,t)).ready)
  throw Error('Complete canonical Routine refund sources required; partial state is not repaired');
 const actual:RoutineRefundActorAddons={...(b.adminRefund?{admin:true}:{}),...(b.manager?{manager:true}:{})};
 const inspect=async(p:RuntimeGiftPeerDeclarations)=>{
  const app=await inspectRuntimeBusinessProfileInTransaction(tx,'app',t,'current',p,c.reader),
   admin=await inspectRuntimeBusinessProfileInTransaction(tx,'admin',t,'current',p);
  const manager=p.manager?await inspectManagerRuntimePrivileges(tx,{requireLogin:true,routine:{target:t,stage:'ready'},
   ...(p.routineRefundActors?.manager?{routineRefund:true}:{})}):null;
  return{ready:app.ready&&admin.ready&&(!manager||manager.ready),failures:[
   ...app.failures.map(n=>'app:'+n),...admin.failures.map(n=>'admin:'+n),...(manager?.failures.map(n=>'manager:'+n)??[])].slice(0,32)};
 };
 if(equal(actual,c.actors)){
  const repeated=await inspect(c.afterPeers);
  if(!repeated.ready)throw Error('Complete repeated refund actor profiles required: '+repeated.failures.join(','));
  return{operation:ROUTINE_REFUND_ACTORS_UPGRADE,applied:false as const,target:t,actors:c.actors,peers:c.afterPeers};
 }
 if(!equal(actual,c.previous))throw Error('Exact previous refund actor state required; partial state is not repaired');
 const prior=await inspect(c.beforePeers);
 if(!prior.ready)throw Error('Exact previous refund actor profiles required; partial state is not repaired: '+prior.failures.join(','));
 for(const[actor,role]of[['admin',t.admin],['manager',MANAGER_RUNTIME_ROLE]] as const){
  if(!c.actors[actor]||c.previous?.[actor])continue;
  for(const[table,privileges]of Object.entries(ROUTINE_REFUND_ACTOR_TABLE_PRIVILEGES))
   await tx.execute(sql.raw(`GRANT ${privileges.join(',')} ON TABLE public.${pricingIdentifier(table)} TO ${pricingIdentifier(role)}`));
 }
 const final=await inspect(c.afterPeers);
 if(!final.ready)throw Error('Final complete refund actor profiles refused: '+final.failures.join(','));
 const after=await inspectRoutineRefundCatalog(tx,t);
 if(!after.ready||after.binding?.adminRefund!==!!c.actors.admin||!!after.binding?.manager!==!!c.actors.manager)throw Error('Final refund actor binding refused');
 return{operation:ROUTINE_REFUND_ACTORS_UPGRADE,applied:true as const,target:t,actors:c.actors,peers:c.afterPeers};
}
export async function upgradeRoutineRefundActors(db:DbClient,target:RoutinePaymentRuntimeTarget,input:RoutineRefundActorsDeclaration,
 peers:RuntimeGiftPeerDeclarations,reader?:RuntimeAppCashierOriginReaderAddon){
 if(!Object.hasOwn(db,'$client')||!db.$client)throw Error('Root refund actor maintenance connection required');
 const c=capture(target,input,peers,reader);
 return db.transaction(tx=>upgradeRoutineRefundActorsInTransaction(tx,c.target,{actors:c.actors,...(c.previous?{previousActors:c.previous}:{})},c.afterPeers,c.reader),
  {isolationLevel:'read committed',accessMode:'read write'});
}
