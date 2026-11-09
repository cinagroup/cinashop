/** Explicit historical SELECT successor only. No payment/account author,
 * provider capability, business grant, role creation or startup integration. */
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import type { RechargeRefundBinding } from './rechargeRefundContract';
import { inspectRechargeRefundCatalog } from './rechargeRefundCatalog';
import { readRechargeRefundSourceReaderPrincipals } from './rechargeRefundSourceReaderAddon';
import { inspectRoutineOriginalPaymentEvidenceCatalog } from './routineOriginalPaymentEvidence';
import { inspectRoutinePaymentAccountPolicyCatalog } from './routinePaymentAccountPolicy';
import { inspectRoutineRefundCatalog, type RoutineRefundCatalog } from './routineRefund';
import { inspectRoutineRefundSourceAclMatrix } from './routineRefundActorAddon';

type Query=Pick<DbClient,'execute'>;
export type RechargeRefundSourceGoodsDeclaration=Readonly<NonNullable<RoutineRefundCatalog['binding']>>;
const sourceTables=['routine_original_payment_evidence','routine_payment_account_policy','routine_payment_account_use'] as const;
const roleKeys=['maintenance','app','admin','financial','manager'] as const;
const bindingKeys=['database','databaseOid',...roleKeys.flatMap(role=>[role,role+'Oid'])] as const;
const goodsKeys=['maintenance','maintenanceOid','app','appOid','admin','adminOid','adminRefund',
 'financial','financialOid','manager','managerOid'] as const;
const fail=(reason:string):never=>{throw Error('Recharge refund source reader commissioning refused: '+reason);};
const oid=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,9}$/.test(v)&&Number(v)<=4_294_967_295;
const name=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
function fields(input:unknown,keys:readonly string[]):Record<string,PropertyDescriptor> {
 if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))
  return fail('plain complete declarations are required');
 const d=Object.getOwnPropertyDescriptors(input);
 if(Reflect.ownKeys(d).length!==keys.length||keys.some(key=>!d[key]?.enumerable||!('value'in d[key])))
  return fail('exact data-only declaration fields are required');
 return d;
}
function captureBinding(input:RechargeRefundBinding):Readonly<RechargeRefundBinding> {
 const d=fields(input,bindingKeys),copy:Record<string,string>=Object.create(null);
 for(const key of bindingKeys) {
  const value:unknown=d[key].value;
  if(!(key.endsWith('Oid')?oid(value):name(value)))return fail('invalid recharge binding scalar');
  copy[key]=value as string;
 }
 if(new Set(roleKeys.map(role=>copy[role])).size!==5||new Set(roleKeys.map(role=>copy[role+'Oid'])).size!==5)
  return fail('five distinct reviewed recharge LOGINs/OIDs are required');
 return Object.freeze(copy) as unknown as Readonly<RechargeRefundBinding>;
}
export function captureRechargeRefundSourceGoodsDeclaration(input:RechargeRefundSourceGoodsDeclaration|undefined,b:RechargeRefundBinding):RechargeRefundSourceGoodsDeclaration|undefined {
 if(input===undefined)return undefined;
 const d=fields(input,goodsKeys),copy:Record<string,string|boolean|null>=Object.create(null);
 for(const key of goodsKeys)copy[key]=d[key].value;
 if(typeof copy.adminRefund!=='boolean')return fail('an explicit goods Admin flag is required');
 for(const role of ['maintenance','app'] as const)
  if(!name(copy[role])||!oid(copy[role+'Oid']))return fail('complete goods Maintenance/App identity required');
 for(const role of ['admin','financial','manager'] as const)
  if(!(copy[role]===null&&copy[role+'Oid']===null)&&!(name(copy[role])&&oid(copy[role+'Oid'])))
   return fail('goods actor name/OID pairs must be explicit');
 if(copy.adminRefund!==(copy.admin!==null))return fail('declare the exact unprojected goods Admin binding');
 if(copy.maintenance!==b.maintenance||copy.maintenanceOid!==b.maintenanceOid||copy.app!==b.app||copy.appOid!==b.appOid)
  return fail('goods and recharge Maintenance/App name+OID bindings differ');
 const active=roleKeys.map(role=>copy[role]).filter(v=>v!==null),activeOids=roleKeys.map(role=>copy[role+'Oid']).filter(v=>v!==null);
 if(new Set(active).size!==active.length||new Set(activeOids).size!==activeOids.length)return fail('distinct goods principals are required');
 return Object.freeze(copy) as unknown as RechargeRefundSourceGoodsDeclaration;
}
function sameBinding(actual:RechargeRefundBinding|null,b:RechargeRefundBinding):boolean {
 return !!actual&&bindingKeys.every(key=>actual[key as keyof RechargeRefundBinding]===b[key as keyof RechargeRefundBinding]);
}
function goodsReaders(goods:RechargeRefundSourceGoodsDeclaration|undefined):string[] {
 return goods?[...(goods.financial?[goods.financial]:[]),...(goods.adminRefund&&goods.admin?[goods.admin]:[]),
  ...(goods.manager?[goods.manager]:[])].sort():[];
}
async function assertContext(tx:Query,b:RechargeRefundBinding):Promise<void> {
 const [row]=await tx.execute<{safe:boolean}>(sql`SELECT pg_catalog.current_database()=${b.database}
  AND (SELECT d.oid::text FROM pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database())=${b.databaseOid}
  AND current_user=session_user AND current_user=${b.maintenance} AND r.oid::text=${b.maintenanceOid}
  AND r.rolcanlogin AND r.rolsuper AND pg_catalog.current_setting('role')='none'
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid() AND a.usesysid=r.oid)
  AND pg_catalog.current_setting('server_version_num')::integer/10000=16
  AND pg_catalog.current_setting('transaction_isolation')='read committed'
  AND pg_catalog.current_setting('transaction_read_only')='off'
  AND pg_catalog.current_setting('session_replication_role')='origin'
  AND pg_catalog.current_schema()='public' AND pg_catalog.current_setting('search_path')='public, pg_temp'
  AND pg_catalog.current_setting('row_security')='off' AND pg_catalog.current_setting('standard_conforming_strings')='on'
  AND (SELECT setting::bigint BETWEEN 1 AND 5000 FROM pg_catalog.pg_settings WHERE name='statement_timeout')
  AND (SELECT setting::bigint BETWEEN 1 AND 1000 FROM pg_catalog.pg_settings WHERE name='lock_timeout')
  AND (SELECT setting::bigint BETWEEN 1 AND 5000 FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS safe
  FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
 if(row?.safe!==true)return fail('direct PG16 maintenance LOGIN/database/context does not match the declaration');
}
async function observe(tx:Query,b:RechargeRefundBinding,goods:RechargeRefundSourceGoodsDeclaration|undefined) {
 const recharge=await inspectRechargeRefundCatalog(tx);
 if(!recharge.commissioned||!sameBinding(recharge.binding,b))return fail('complete exact recharge commissioning is required');
 const principals=await readRechargeRefundSourceReaderPrincipals(tx,{maintenance:b.maintenance,app:b.app});
 if(!principals||principals.length!==2||principals[0].name!==b.admin||principals[0].oid!==b.adminOid
  ||principals[1].name!==b.financial||principals[1].oid!==b.financialOid)
  return fail('independent recharge reader identities or source owners differ');
 if(goods) {
  // No declaredNames projection: every nullable actor/flag is compared against
  // the actual complete goods catalog, not filled from a caller role name.
  const catalog=await inspectRoutineRefundCatalog(tx),actual=catalog.binding;
  if(!catalog.ready||!actual||!goodsKeys.every(key=>actual[key]===goods[key]))
   return fail('the optional independent goods declaration differs or is not fully ready');
 }
 const names={maintenance:b.maintenance,app:b.app},previous=goodsReaders(goods),successor=[...new Set([
  ...previous,...principals.map(principal=>principal.name)])].sort();
 const isPrevious=await inspectRoutineRefundSourceAclMatrix(tx,names,previous);
 const isSuccessor=await inspectRoutineRefundSourceAclMatrix(tx,names,successor);
 if(!isPrevious&&!isSuccessor)return fail('only the exact declared predecessor or full successor is accepted; no partial repair');
 const original=await inspectRoutineOriginalPaymentEvidenceCatalog(tx),account=await inspectRoutinePaymentAccountPolicyCatalog(tx);
 for(const catalog of [original,account]) {
  const actual=catalog.binding;
  if(!catalog.ready||!actual||actual.maintenance!==b.maintenance||actual.maintenanceOid!==b.maintenanceOid
   ||actual.app!==b.app||actual.appOid!==b.appOid)return fail('complete original payment source catalog/binding is required');
 }
 return {isPrevious,isSuccessor,previous,successor};
}
async function structuralSnapshot(tx:Query):Promise<string> {
 const [row]=await tx.execute<{facts:unknown}>(sql`SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
  'class',pg_catalog.to_jsonb(c)-'relacl','comment',pg_catalog.obj_description(c.oid,'pg_class'),
  'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('attribute',pg_catalog.to_jsonb(a),
    'comment',pg_catalog.col_description(c.oid,a.attnum)) ORDER BY a.attnum)
   FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0),
  'constraints',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(k) ORDER BY k.oid)
   FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid),
  'indexes',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(i) ORDER BY i.indexrelid)
   FROM pg_catalog.pg_index i WHERE i.indrelid=c.oid),
  'triggers',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid)
   FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid)) ORDER BY c.relname COLLATE "C") AS facts
  FROM pg_catalog.pg_class c WHERE c.oid IN(pg_catalog.to_regclass('public.routine_original_payment_evidence'),
   pg_catalog.to_regclass('public.routine_payment_account_policy'),pg_catalog.to_regclass('public.routine_payment_account_use'))`);
 if(!Array.isArray(row?.facts)||row.facts.length!==3)return fail('all three source metadata snapshots are required');
 return JSON.stringify(row.facts);
}
export interface RechargeRefundSourceReaderCommissionResult {
 readonly binding:Readonly<RechargeRefundBinding>;
 readonly goods:RechargeRefundSourceGoodsDeclaration|null;
 readonly replayed:boolean;
 readonly grantedPrivileges:number;
}

/** Caller supplies reviewed OIDs before BEGIN. The optional goods declaration
 * accounts only for pre-existing independently proved source readers. It does
 * not commission goods actors. Exactly three SELECTs per missing recharge
 * reader are added in one transaction; exact replay performs no GRANT. */
export async function runRechargeRefundSourceReaderCommission(rootDb:DbClient,input:RechargeRefundBinding,
 goodsInput?:RechargeRefundSourceGoodsDeclaration):Promise<Readonly<RechargeRefundSourceReaderCommissionResult>> {
 const binding=captureBinding(input),goods=captureRechargeRefundSourceGoodsDeclaration(goodsInput,binding),client=Object.getOwnPropertyDescriptor(rootDb,'$client');
 if(!client||!('value'in client)||!client.value||typeof client.value.begin!=='function')return fail('a root postgres-js database is required');
 return rootDb.transaction(rawTx=>commissionRechargeRefundSourceReadersInTransaction(rawTx as unknown as DbClient,binding,goods),{isolationLevel:'read committed',accessMode:'read write'});
}

export async function commissionRechargeRefundSourceReadersInTransaction(tx:Query,input:RechargeRefundBinding,
 goodsInput?:RechargeRefundSourceGoodsDeclaration):Promise<Readonly<RechargeRefundSourceReaderCommissionResult>> {
 const binding=captureBinding(input),goods=captureRechargeRefundSourceGoodsDeclaration(goodsInput,binding);
  if(Object.hasOwn(tx,'$client'))return fail('a root object cannot stand in for the transaction');
  await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
  await tx.execute(sql`SET LOCAL row_security TO off`);
  await tx.execute(sql`SET LOCAL standard_conforming_strings TO on`);
  await tx.execute(sql`SELECT
   pg_catalog.set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000),5000)::text||'ms',true),
   pg_catalog.set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000),1000)::text||'ms',true),
   pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true)`);
  await assertContext(tx,binding);
  // Same relative order as the published source/account/goods successors;
  // recharge is last. Every gate is try-only and precedes physical resources.
  for(const key of [731714,731717,731718,731729]) {
   const [gate]=await tx.execute<{held:boolean}>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(${key},0) AS held`);
   if(gate?.held!==true)return fail('source/account/goods/recharge maintenance gate is busy');
  }
  await tx.execute(sql`LOCK TABLE ONLY public.routine_original_payment_evidence,ONLY public.routine_payment_account_policy,
   ONLY public.routine_payment_account_use IN ACCESS EXCLUSIVE MODE NOWAIT`);
  const before=await observe(tx,binding,goods),metadata=await structuralSnapshot(tx);
  await assertContext(tx,binding);
  if(before.isSuccessor)return Object.freeze({binding,goods:goods??null,replayed:true,grantedPrivileges:0});
  if(!before.isPrevious)return fail('the exact predecessor is required');
  let grantedPrivileges=0;
  for(const role of [binding.admin,binding.financial]) {
   if(before.previous.includes(role))continue;
   for(const table of sourceTables) {
    await tx.execute(sql`GRANT SELECT ON TABLE public.${sql.identifier(table)} TO ${sql.identifier(role)}`);
    grantedPrivileges++;
   }
  }
  const after=await observe(tx,binding,goods);
  if(!after.isSuccessor||await structuralSnapshot(tx)!==metadata)return fail('exact SELECT successor or structural preservation failed');
  await assertContext(tx,binding);
  return Object.freeze({binding,goods:goods??null,replayed:false,grantedPrivileges});
}

