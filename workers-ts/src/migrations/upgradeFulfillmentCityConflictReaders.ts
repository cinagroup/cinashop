import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import type { RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';
import { captureRuntimeGiftPeerDeclarations, type RuntimeGiftPeerDeclarations } from './customerRuntimeGiftPeers';
import { captureRuntimeAppCashierOriginReader, type RuntimeAppCashierOriginReaderAddon } from './runtimeAppCashierOriginReader';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { inspectManagerRuntimePrivileges } from './auditManagerRuntimePrivileges';
import { MANAGER_RUNTIME_ROLE } from './managerRuntimePrivilegePlan';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from './customerFinancialRuntimePlan';
import { captureFulfillmentCityConflictReadersAddon, FULFILLMENT_CITY_CONFLICT_GATE,
  fulfillmentCityConflictReaderInstallSql, inspectFulfillmentCityConflictReader,
  resolveFulfillmentCityConflictReaderBinding, type FulfillmentCityConflictReadersAddon } from './fulfillmentCityConflictReader';

type Query=Pick<DbClient,'execute'>;
export const FULFILLMENT_CITY_CONFLICT_READERS_UPGRADE='fulfillment-city-conflict-readers-v1';
export interface FulfillmentCityConflictReadersDeclaration {
  readers:FulfillmentCityConflictReadersAddon;
  previousReaders?:FulfillmentCityConflictReadersAddon;
}
const same=(a:FulfillmentCityConflictReadersAddon|undefined,b:FulfillmentCityConflictReadersAddon|undefined)=>
  a?.owner===b?.owner&&(['app','admin','manager'] as const).every(k=>!!a?.[k]===!!b?.[k]);

/** Copy the complete intent before BEGIN. Neither a getter nor later array
 * mutation may change the old profile, new actors or dedicated owner. */
function snapshot<T>(value:T):T {
  let nodes=0,bytes=0;
  const copy=(v:unknown,depth:number):unknown=>{
    if(++nodes>256||depth>8)throw Error('Bounded city reader declaration required');
    if(v===null||v===undefined||typeof v==='boolean')return v;
    if(typeof v==='string'){bytes+=v.length;if(v.length>1024||bytes>65536)throw Error('Bounded city reader strings required');return v;}
    if(typeof v==='number'&&Number.isSafeInteger(v))return v;
    if(!v||typeof v!=='object'||(Array.isArray(v)?Object.getPrototypeOf(v)!==Array.prototype:
      ![Object.prototype,null].includes(Object.getPrototypeOf(v))))throw Error('Plain city reader declaration required');
    const descriptors=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(v);
    if(Array.isArray(v)){
      if(v.length>32||keys.length!==v.length+1||keys.some(k=>typeof k!=='string'||k!=='length'&&(!/^(0|[1-9][0-9]*)$/u.test(k)||Number(k)>=v.length)))
        throw Error('Dense bounded city reader arrays required');
      return Array.from({length:v.length},(_,i)=>{const d=descriptors[String(i)];if(!d?.enumerable||!('value'in d))throw Error('Plain city reader array required');return copy(d.value,depth+1);});
    }
    const result:Record<string,unknown>=Object.create(null);
    for(const key of keys){if(typeof key!=='string'||!descriptors[key]?.enumerable||!('value'in descriptors[key]))throw Error('Data-only city reader declaration required');result[key]=copy(descriptors[key].value,depth+1);}
    return result;
  };
  return copy(value,0) as T;
}
function capture(target:RoutinePaymentRuntimeTarget,input:FulfillmentCityConflictReadersDeclaration,
  peers:RuntimeGiftPeerDeclarations,reader?:RuntimeAppCashierOriginReaderAddon){
  const raw=snapshot({target,input,peers,...(reader===undefined?{}:{reader})}),t=raw.target;
  if(!t||typeof t!=='object'||Array.isArray(t))throw Error('Explicit city reader target required');
  const identity=(v:unknown):string=>{if(typeof v!=='string')throw Error('Primitive city reader identity required');pricingIdentifier(v);return v;};
  if(t.local!==undefined&&(!Array.isArray(t.local)||t.local.length>16))throw Error('Bounded city reader local identities required');
  if(t.caseLock&&(!Array.isArray(t.caseLock.runtimeRoles)||!t.caseLock.runtimeRoles.length||t.caseLock.runtimeRoles.length>16))throw Error('Explicit city reader case-lock required');
  const captured:RoutinePaymentRuntimeTarget={database:identity(t.database),maintenance:identity(t.maintenance),app:identity(t.app),admin:identity(t.admin),
    ...(t.local?{local:t.local.map(identity)}:{}),...(t.caseLock?{caseLock:{owner:identity(t.caseLock.owner),runtimeRoles:t.caseLock.runtimeRoles.map(identity)}}:{})};
  const identities=[captured.maintenance,captured.app,captured.admin,...(captured.local??[])];
  if(new Set(identities).size!==identities.length||captured.caseLock&&(identities.includes(captured.caseLock.owner)
    ||new Set(captured.caseLock.runtimeRoles).size!==captured.caseLock.runtimeRoles.length||captured.caseLock.runtimeRoles.some(n=>!captured.local?.includes(n))))
    throw Error('Distinct bounded city reader target required');
  if(!raw.input||typeof raw.input!=='object'||Array.isArray(raw.input)
    ||Reflect.ownKeys(raw.input).some(k=>typeof k!=='string'||!['readers','previousReaders'].includes(k)))throw Error('Exact city reader forward required');
  const readers=captureFulfillmentCityConflictReadersAddon(raw.input.readers),previous=raw.input.previousReaders===undefined?undefined:captureFulfillmentCityConflictReadersAddon(raw.input.previousReaders);
  if(identities.includes(readers.owner)||readers.owner===captured.caseLock?.owner||previous&&(previous.owner!==readers.owner
    ||(['app','admin','manager'] as const).some(k=>previous[k]&&!readers[k])))throw Error('Dedicated city reader owner and monotone actors required');
  const afterPeers=captureRuntimeGiftPeerDeclarations(raw.peers);
  const binding=(v:RoutinePaymentRuntimeTarget)=>JSON.stringify([v.database,v.maintenance,v.app,v.admin,[...(v.local??[])].sort(),v.caseLock?[v.caseLock.owner,[...v.caseLock.runtimeRoles].sort()]:null]);
  if(binding(captured)!==binding(afterPeers.target)||!same(readers,afterPeers.cityConflictReaders))throw Error('Exact city reader successor peers required');
  if(!afterPeers.financial||!afterPeers.cashierSecondCard||!afterPeers.manager
    ||!captured.local?.includes(CUSTOMER_FINANCIAL_RUNTIME_ROLE)||!captured.local.includes(MANAGER_RUNTIME_ROLE)
    ||!captured.local.includes(afterPeers.cashierSecondCard.role))throw Error('Complete five runtime city reader peers required');
  const {cityConflictReaders:_,...basePeers}=afterPeers;
  const beforePeers:RuntimeGiftPeerDeclarations={...basePeers,...(previous?{cityConflictReaders:previous}:{})};
  return{target:captured,readers,previous,beforePeers,afterPeers,reader:raw.reader===undefined?undefined:captureRuntimeAppCashierOriginReader(raw.reader)};
}

/** Explicit maintenance forward. It provisions no role and changes no business
 * row or city writer permission. Exact repeats are read-only; unknown/partial
 * definitions and unrelated privileges are never repaired. */
export async function upgradeFulfillmentCityConflictReadersInTransaction(tx:Query,target:RoutinePaymentRuntimeTarget,
  input:FulfillmentCityConflictReadersDeclaration,peers:RuntimeGiftPeerDeclarations,reader?:RuntimeAppCashierOriginReaderAddon){
  if(Object.hasOwn(tx,'$client'))throw Error('Existing city reader maintenance transaction required');
  const c=capture(target,input,peers,reader),t=c.target,names={maintenance:t.maintenance,app:t.app,admin:t.admin};
  await tx.execute(sql`SELECT pg_catalog.set_config('search_path','public,pg_temp',true),
    pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const [identity]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.current_database()=${t.database} AND current_user=${t.maintenance}
    AND current_user=session_user AND pg_catalog.current_setting('role')='none' AND pg_catalog.current_schema()='public'
    AND r.rolsuper AND r.rolcanlogin AND r.oid=(SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid())
    AND pg_catalog.current_setting('server_version_num')::integer/10000=16 AND pg_catalog.current_setting('transaction_isolation')='read committed'
    AND pg_catalog.current_setting('transaction_read_only')='off' AND pg_catalog.current_setting('session_replication_role')='origin'
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS ready
    FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
  if(identity?.ready!==true)throw Error('Actual PG16 city reader maintenance LOGIN/database required');
  for(const [key,subkey]of[[731669,0],[731670,0],[731625,2],[731624,0],[731685,0],[731812,1],[731714,0],[731717,0],[731718,0],[731719,0],[731735,0],FULFILLMENT_CITY_CONFLICT_GATE]){
    const [gate]=await tx.execute<{locked:boolean}>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(${key},${subkey}) AS locked`);
    if(gate?.locked!==true)throw Error('City reader commissioning is busy');
  }
  const initial=await inspectFulfillmentCityConflictReader(tx,names);
  if(initial.present&&!initial.ready)throw Error('City reader catalog drift; partial state is not repaired');
  const actual=initial.binding?{owner:initial.binding.owner,...initial.binding.actors}:undefined;
  const inspect=async(p:RuntimeGiftPeerDeclarations)=>{
    const app=await inspectRuntimeBusinessProfileInTransaction(tx,'app',t,'current',p,c.reader),
      admin=await inspectRuntimeBusinessProfileInTransaction(tx,'admin',t,'current',p),
      manager=await inspectManagerRuntimePrivileges(tx,{requireLogin:true,routine:{target:t,stage:'ready'},
        ...(p.routineRefundActors?.manager?{routineRefund:true}:{}),...(p.cityConflictReaders?.manager?{cityConflictReaders:p.cityConflictReaders}:{}),
        ...(p.fulfillmentAssignments?{fulfillmentAssignments:p.fulfillmentAssignments}:{})});
    return{ready:app.ready&&admin.ready&&manager.ready,failures:[...app.failures.map(n=>'app:'+n),...admin.failures.map(n=>'admin:'+n),...manager.failures.map(n=>'manager:'+n)].slice(0,32)};
  };
  if(same(actual,c.readers)){
    const repeated=await inspect(c.afterPeers);
    if(!repeated.ready)throw Error('Complete repeated city reader profiles required: '+repeated.failures.join(','));
    return{operation:FULFILLMENT_CITY_CONFLICT_READERS_UPGRADE,applied:false as const,target:t,readers:c.readers,peers:c.afterPeers};
  }
  if(!same(actual,c.previous))throw Error('Exact previous city reader state required');
  const prior=await inspect(c.beforePeers);
  if(!prior.ready)throw Error('Exact previous city reader profiles required: '+prior.failures.join(','));
  const resolved=await resolveFulfillmentCityConflictReaderBinding(tx,names,c.readers);
  await tx.execute(sql.raw('LOCK TABLE '+['customer_city_delivery_attempt','customer_city_delivery_binding','customer_city_delivery_job','store_delivery_order']
    .map(n=>'ONLY public.'+pricingIdentifier(n)).join(',')+' IN ACCESS EXCLUSIVE MODE NOWAIT'));
  await tx.execute(sql.raw(fulfillmentCityConflictReaderInstallSql(resolved.binding,initial.present?{replace:true}:{})));
  const final=await inspectFulfillmentCityConflictReader(tx,names),post=await inspect(c.afterPeers);
  if(!final.ready||!final.binding||!same({owner:final.binding.owner,...final.binding.actors},c.readers)||!post.ready)
    throw Error('Final city reader contract refused: '+[...final.failures,...post.failures].join(','));
  return{operation:FULFILLMENT_CITY_CONFLICT_READERS_UPGRADE,applied:true as const,target:t,readers:c.readers,peers:c.afterPeers};
}
export async function upgradeFulfillmentCityConflictReaders(db:DbClient,target:RoutinePaymentRuntimeTarget,
  input:FulfillmentCityConflictReadersDeclaration,peers:RuntimeGiftPeerDeclarations,reader?:RuntimeAppCashierOriginReaderAddon){
  if(!Object.hasOwn(db,'$client')||!db.$client)throw Error('Root city reader maintenance connection required');
  const c=capture(target,input,peers,reader);
  return db.transaction(tx=>upgradeFulfillmentCityConflictReadersInTransaction(tx,c.target,
    {readers:c.readers,...(c.previous?{previousReaders:c.previous}:{})},c.afterPeers,c.reader),{isolationLevel:'read committed',accessMode:'read write'});
}
