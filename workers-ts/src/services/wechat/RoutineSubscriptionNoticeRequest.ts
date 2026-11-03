import type { NoticeBusiness, RoutineSubscriptionNoticeRequest } from './RoutineSubscriptionRequestEvidenceCodec';
export { parseRoutineSubscriptionNoticeRequest } from './RoutineSubscriptionRequestEvidenceCodec';
export type { NoticeBusiness, RoutineSubscriptionNoticeRequest } from './RoutineSubscriptionRequestEvidenceCodec';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { inspectRoutineSubscriptionDeliveryCatalog } from '@/migrations/routineSubscriptionDelivery';
import { freezeSubscription, routineSubscriptionUnavailable, subscriptionInteger,
 subscriptionMac, subscriptionObject, type RoutineSubscriptionScope } from './RoutineSubscriptionAccount';

type Query=Pick<DbClient,'execute'>;
type Signing=Readonly<{APP_KEY?:string}>;
export interface RoutineSubscriptionNoticeUnavailable {readonly format:2;readonly unavailable:true}
export type RoutineSubscriptionNoticeRequestOutcome={readonly kind:'legacy'}|{
 readonly kind:'original';readonly request:Readonly<RoutineSubscriptionNoticeRequest|RoutineSubscriptionNoticeUnavailable>;
};
const UNAVAILABLE=Object.freeze({kind:'original' as const,request:Object.freeze({format:2 as const,unavailable:true as const})});
const name=(value:unknown):value is string=>typeof value==='string'&&/^[a-z_][a-z0-9_]{0,62}$/u.test(value)
 &&!value.startsWith('pg_')&&value!=='information_schema';
const oid=(value:unknown):value is string=>typeof value==='string'&&/^[1-9][0-9]{0,9}$/u.test(value)&&BigInt(value)<=4294967295n;
function text(value:unknown,max:number,required=false):value is string{
 if(typeof value!=='string'||required&&!value||value.length>max*2)return false;
 let count=0;for(const character of value){const point=character.codePointAt(0)!;if(++count>max||point>=0xd800&&point<=0xdfff)return false;}
 return true;
}
function signing(value:Signing|undefined):Readonly<Pick<Env,'APP_KEY'>>|undefined{
 if(!value||typeof value!=='object')return;
 const descriptor=Object.getOwnPropertyDescriptor(value,'APP_KEY');
 if(!descriptor||!descriptor.enumerable||!('value'in descriptor)||typeof descriptor.value!=='string'
  ||!descriptor.value||descriptor.value.length>8192)return;
 return Object.freeze({APP_KEY:descriptor.value});
}
function scopeValue(value:unknown):Readonly<RoutineSubscriptionScope>{
 const r=subscriptionObject(value,['database','databaseOid','maintenance','maintenanceOid']);
 if(!name(r.database)||!oid(r.databaseOid)||!name(r.maintenance)||!oid(r.maintenanceOid))return routineSubscriptionUnavailable();
 return Object.freeze({database:r.database,databaseOid:r.databaseOid,maintenance:r.maintenance,maintenanceOid:r.maintenanceOid});
}
/** Exact primitive copy, never an arbitrary payload spread. A guest/fictitious
 * body may be compared by a caller, but cannot become a signed Mini request. */
export function captureRoutineSubscriptionNoticeBusiness(value:unknown):Readonly<NoticeBusiness>{
 if(!value||typeof value!=='object')return routineSubscriptionUnavailable();
 const keys=['orderId','orderNo','userId','deliveryType','deliveryName','deliveryId','userAddress'];
 if(Object.hasOwn(value,'cityDeliveryJobId'))keys.push('cityDeliveryJobId');
 const r=subscriptionObject(value,keys);
 if(!subscriptionInteger(r.orderId)||!text(r.orderNo,32,true)||!Number.isSafeInteger(r.userId)
  ||Number(r.userId)<0||Number(r.userId)>2147483647
  ||typeof r.deliveryType!=='string'||!['express','send','fictitious','city_delivery'].includes(r.deliveryType)
  ||!text(r.deliveryName,64)||!text(r.deliveryId,64)||!text(r.userAddress,100)
  ||(r.deliveryType==='city_delivery'?!subscriptionInteger(r.cityDeliveryJobId):Object.hasOwn(r,'cityDeliveryJobId')))
  return routineSubscriptionUnavailable();
 return Object.freeze({orderId:r.orderId,orderNo:r.orderNo,userId:r.userId as number,deliveryType:r.deliveryType as NoticeBusiness['deliveryType'],
  deliveryName:r.deliveryName,deliveryId:r.deliveryId,userAddress:r.userAddress,
  ...(r.deliveryType==='city_delivery'?{cityDeliveryJobId:r.cityDeliveryJobId as number}:{})});
}
function eventKey(body:Readonly<NoticeBusiness>){
 return `order.delivery.notice:${body.orderId}`+(body.deliveryType==='city_delivery'?`:city:${body.cityDeliveryJobId}`:'');
}
function capture(value:{eventKey:string;aggregateId:number;payload:NoticeBusiness;now:number}){
 const r=subscriptionObject(value,['eventKey','aggregateId','payload','now']),body=captureRoutineSubscriptionNoticeBusiness(r.payload);
 if(r.eventKey!==eventKey(body)||r.aggregateId!==body.orderId||!subscriptionInteger(r.now))return routineSubscriptionUnavailable();
 return Object.freeze({eventKey:r.eventKey as string,aggregateId:body.orderId,body,eventTime:r.now});
}
export interface RoutineSubscriptionNoticeWriterProvenance {
 readonly scope:Readonly<RoutineSubscriptionScope>;readonly actor:Readonly<{role:string;roleOid:string}>;readonly createdAt:number;
}
/** Candidate writer provenance only. Callers must independently prove their
 * commissioned catalog before passing its public owner binding. No private
 * business ledger, new gate or transaction-setting change is used here. */
export async function readRoutineSubscriptionNoticeWriterTx(tx:Query,binding:Readonly<{maintenance:string;maintenanceOid:string}>):Promise<Readonly<RoutineSubscriptionNoticeWriterProvenance>|null>{
 if(Object.hasOwn(tx,'$client'))return null;
 const maintenance=binding.maintenance,maintenanceOid=binding.maintenanceOid;
 const [who]=await tx.execute<{database:string;databaseOid:string;role:string;roleOid:string;now:string;ready:boolean}>(sql`SELECT
  pg_catalog.current_database() AS database,
  (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS "databaseOid",
  current_user AS role,r.oid::text AS "roleOid",
  pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp()))::bigint::text AS now,
  current_user=session_user AND r.oid=(SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid())
  AND current_user<>${maintenance}::name AND r.oid<>${maintenanceOid}::oid
  AND pg_catalog.current_setting('server_version_num')::integer/10000=16
  AND pg_catalog.current_setting('transaction_isolation')='read committed' AND pg_catalog.current_setting('transaction_read_only')='off'
  AND pg_catalog.current_schema()='public' AND pg_catalog.current_setting('session_replication_role')='origin'
  AND pg_catalog.to_regclass('store_order_outbox')=pg_catalog.to_regclass('public.store_order_outbox')
  AND r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
  AND pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CONNECT')
  AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE')
  AND pg_catalog.has_table_privilege(r.oid,'public.store_order_outbox','SELECT')
  AND pg_catalog.has_table_privilege(r.oid,'public.store_order_outbox','INSERT')
  AND NOT pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
  AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM') AS ready
  FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
 if(who?.ready!==true||!name(who.role)||!oid(who.roleOid)||typeof who.now!=='string'||!/^\d+$/u.test(who.now))return null;
 const createdAt=Number(who.now);if(!subscriptionInteger(createdAt))return null;
 let scope:Readonly<RoutineSubscriptionScope>;
 try{scope=scopeValue({database:who.database,databaseOid:who.databaseOid,maintenance,maintenanceOid});}catch{return null;}
 return Object.freeze({scope,actor:Object.freeze({role:who.role,roleOid:who.roleOid}),createdAt});
}
/** A candidate for a genuinely new business event, never ownership or send
 * authority. The caller alone retains an INSERT winner; existing/on-conflict
 * events keep their original version, absence, pin and signature. No private
 * payment/identity rows, GUC changes, gates or external I/O are used here. SQL
 * errors propagate so the caller can roll back its real optional savepoint. */
export async function createRoutineSubscriptionNoticeRequestTx(tx:Query,env:Signing|undefined,
 raw:{eventKey:string;aggregateId:number;payload:NoticeBusiness;now:number}):Promise<RoutineSubscriptionNoticeRequestOutcome>{
 const captured=capture(raw),key=signing(env);
 const catalog=await inspectRoutineSubscriptionDeliveryCatalog(tx),binding=catalog.binding;
 if(!catalog.present)return Object.freeze({kind:'legacy' as const});
 if(!catalog.ready||!binding?.app||!binding.appOid||!key||Object.hasOwn(tx,'$client')
  ||captured.body.userId===0||captured.body.deliveryType==='fictitious')return UNAVAILABLE;
 const writer=await readRoutineSubscriptionNoticeWriterTx(tx,binding);if(!writer)return UNAVAILABLE;
 const {scope,actor,createdAt}=writer;
 const body={format:2 as const,requestId:randomUUID(),scope,actor,
  eventKey:captured.eventKey,aggregateId:captured.aggregateId,eventTime:captured.eventTime,body:captured.body,createdAt};
 return Object.freeze({kind:'original' as const,request:freezeSubscription({...body,signature:subscriptionMac(key,'notice-request',body)})});
}
/** Historical signed provenance only. The writer need not still exist or remain
 * enabled today. This establishes no current owner, template approval, latest
 * policy, token or permission to POST; App admission proves those separately. */
