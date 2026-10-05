import { eq, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeOrder, user } from '@/models/schema';
import { lockOrderSettlement } from '@/services/order/OrderBrokerageService';
import { normalizeOutRequestKey, outRequestHash } from '@/services/out/OutIdempotency';
import { assertCustomerWorkOperationCatalog, customerWorkOperationReadiness } from '@/migrations/runCustomerWorkOperation';
import { acquireCustomerWorkScopeLock } from '@/migrations/runCustomerWorkScopeLock';
import { HttpApiException, ValidateException, NotFoundException, AuthException } from '@/utils/errors';
import { authorizeCustomerWorkActor, customerWorkId, type CustomerWorkActor, type CustomerWorkScope } from './CustomerWorkScope';
export { customerWorkOperationReadiness } from '@/migrations/runCustomerWorkOperation';

export const CUSTOMER_OPERATION_VERSION = 'customer-work-operation-v1' as const;
export type CustomerOperationKind = 'remark'|'manual_delivery'|'split_delivery'|'electronic_waybill'|'electronic_split_waybill'|'city_delivery'|'city_split_delivery'|'waybill_apply_existing'|'waybill_confirm_issued'|'waybill_confirm_retry'|'waybill_close';
export type CustomerOperationOutcome = 'remark-saved'|'delivery-recorded'|'provider-admitted'|'job-updated'|'abandoned'|'rollback-rejected';
export type CustomerJson = null|boolean|number|string|CustomerJson[]|{[key:string]:CustomerJson};
export interface CustomerOperationInput { readonly version:typeof CUSTOMER_OPERATION_VERSION; readonly scope_key:string; readonly order_id:number; readonly expected_order_revision:string; readonly expected_fulfillment_revision:string; readonly payload:CustomerJson }
export interface CustomerOperationContext { readonly actor:CustomerWorkActor; readonly request_key:string }
export interface PreparedCustomerOperation { readonly actor:CustomerWorkActor; readonly key:string; readonly hash:string; readonly kind:CustomerOperationKind; readonly input:CustomerOperationInput }
export interface CustomerOperationReceipt { version:typeof CUSTOMER_OPERATION_VERSION; request_key:string; request_hash:string; actor_uid:number; service_id:number; order_id:number; kind:CustomerOperationKind; outcome:CustomerOperationOutcome; evidence:Readonly<Record<string,CustomerJson>> }
export interface CustomerOperationResult { receipt:CustomerOperationReceipt; replayed:boolean }
type Order = typeof storeOrder.$inferSelect;
const kinds = new Set<string>(['remark','manual_delivery','split_delivery','electronic_waybill','electronic_split_waybill','city_delivery','city_split_delivery','waybill_apply_existing','waybill_confirm_issued','waybill_confirm_retry','waybill_close']);
const hashes = /^[a-f0-9]{64}$/;
const outcomes:Record<CustomerOperationKind,CustomerOperationOutcome> = {remark:'remark-saved',manual_delivery:'delivery-recorded',split_delivery:'delivery-recorded',electronic_waybill:'provider-admitted',electronic_split_waybill:'provider-admitted',city_delivery:'provider-admitted',city_split_delivery:'provider-admitted',waybill_apply_existing:'job-updated',waybill_confirm_issued:'job-updated',waybill_confirm_retry:'job-updated',waybill_close:'job-updated'};
function copy(value:unknown,depth=0):CustomerJson {
  if(depth>16)throw new ValidateException('工作台操作内容层级过深');
  if(value===null||typeof value==='boolean'||typeof value==='string')return value;
  if(typeof value==='number'&&Number.isSafeInteger(value))return value;
  if(Array.isArray(value))return Object.freeze(value.map(v=>copy(v,depth+1))) as unknown as CustomerJson[];
  if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype){const result:Record<string,CustomerJson>={};for(const key of Object.keys(value).sort()){if(['__proto__','constructor','prototype'].includes(key))throw new ValidateException('工作台操作字段无效');result[key]=copy((value as Record<string,unknown>)[key],depth+1);}return Object.freeze(result);}
  throw new ValidateException('工作台操作须为有限JSON');
}
export function freezeCustomerJson(value:unknown,max=262144):CustomerJson {const result=copy(value);if(new TextEncoder().encode(JSON.stringify(result)).length>max)throw new ValidateException('工作台操作内容超过容量');return result;}
export function freezeCustomerActor(value:CustomerWorkActor):CustomerWorkActor {const uid=customerWorkId(value?.uid);if(!/^[a-f0-9]{32}$/.test(value?.auth_version??'')||!Number.isSafeInteger(value.expires_at)||value.expires_at<=0)throw new ValidateException('工作台会话无效');return Object.freeze({uid,auth_version:value.auth_version,expires_at:value.expires_at});}
export async function prepareCustomerOperation(kind:CustomerOperationKind,context:CustomerOperationContext,value:unknown):Promise<PreparedCustomerOperation>{
  if(!kinds.has(kind))throw new ValidateException('工作台操作种类无效');
  const actor=freezeCustomerActor(context.actor),key=normalizeOutRequestKey(context.request_key),body=freezeCustomerJson(value) as unknown as Record<string,unknown>;
  if(!body||Array.isArray(body)||Object.keys(body).sort().join(',')!=='expected_fulfillment_revision,expected_order_revision,order_id,payload,scope_key,version'||body.version!==CUSTOMER_OPERATION_VERSION||typeof body.order_id!=='number'||!hashes.test(String(body.scope_key))||!hashes.test(String(body.expected_order_revision))||!hashes.test(String(body.expected_fulfillment_revision)))throw new ValidateException('原手机工作台操作合同无效');
  const input=Object.freeze({version:CUSTOMER_OPERATION_VERSION,scope_key:String(body.scope_key),order_id:customerWorkId(body.order_id,'订单'),expected_order_revision:String(body.expected_order_revision),expected_fulfillment_revision:String(body.expected_fulfillment_revision),payload:body.payload as CustomerJson});
  return Object.freeze({actor,key,kind,input,hash:await outRequestHash({version:CUSTOMER_OPERATION_VERSION,actor_uid:actor.uid,kind,input})});
}
/** Only a currently authenticated owner may recover a minimal receipt. This
 * authority does not allow a new operation after the customer role is removed. */
export async function authorizeCustomerOperationOwner(tx:DbClient,value:CustomerWorkActor){
  const actor=freezeCustomerActor(value),rows=await tx.select({uid:user.uid,status:user.status,isDel:user.isDel,deleteTime:user.deleteTime,digest:sql<string>`md5(${user.pwd})`}).from(user).where(eq(user.uid,actor.uid)).limit(1).for('share',{noWait:true});
  if(actor.expires_at<=Math.floor(Date.now()/1000)||rows.length!==1||rows[0].status!==1||rows[0].isDel!==0||rows[0].deleteTime!==null||rows[0].digest!==actor.auth_version)throw new HttpApiException('工作台会话已失效，请重新登录后核对原操作',403,403);
}
async function lockRequest(tx:DbClient,uid:number,key:string,write=true){
  if(Object.hasOwn(tx,'$client'))throw Error('Customer operations require caller-owned transaction');
  await assertCustomerWorkOperationCatalog(tx);
  await tx.execute(sql`LOCK TABLE public.customer_work_operation_request IN ROW SHARE MODE NOWAIT`);
  if(write&&!(await customerWorkOperationReadiness(tx)).ready)throw new HttpApiException('手机工作台操作台账权限尚未验收',503,503);
  await tx.execute(sql`SET LOCAL row_security=off`);
  await tx.execute(sql`SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1500)::text||'ms',true)`);
  const digest=await outRequestHash([uid,key]);await tx.execute(sql`SELECT pg_advisory_xact_lock(731635::int,${parseInt(digest.slice(0,8),16)|0}::int)`);
}
async function readReceipt(tx:DbClient,uid:number,key:string):Promise<CustomerOperationReceipt|null>{
  const rows=await tx.execute<{actor_uid:number;service_id:number;order_id:number;request_hash:string;kind:CustomerOperationKind;outcome:CustomerOperationOutcome;evidence:Record<string,CustomerJson>}>(sql`SELECT actor_uid,service_id,order_id,request_hash,kind,outcome,evidence FROM public.customer_work_operation_request WHERE actor_uid=${uid} AND request_key=${key}::uuid LIMIT 2`);
  if(rows.length>1)throw Error('Customer receipt identity ambiguous');return rows[0]?{version:CUSTOMER_OPERATION_VERSION,request_key:key,...rows[0]}:null;
}
function same(receipt:CustomerOperationReceipt,p:PreparedCustomerOperation){if(receipt.request_hash!==p.hash||receipt.kind!==p.kind||receipt.order_id!==p.input.order_id)throw new HttpApiException('原请求键已经用于不同手机工作台操作',409,409);}
async function priorReceipt(tx:DbClient,p:PreparedCustomerOperation){await lockRequest(tx,p.actor.uid,p.key);const prior=await readReceipt(tx,p.actor.uid,p.key);if(prior)same(prior,p);return prior;}
/** Acquire the financial root before user/role resources. A customer caller
 * addresses the exact physical target returned by its bootstrap, never uid-as-admin. */
export async function lockCustomerWorkOrder(tx:DbClient,id:number,allowFulfilledHeader=false):Promise<Order>{
  const [hint]=await tx.select({id:storeOrder.id,pid:storeOrder.pid}).from(storeOrder).where(eq(storeOrder.id,id)).limit(1);if(!hint)throw new NotFoundException('订单不存在');const rootId=hint.pid>0?hint.pid:id;
  await lockOrderSettlement(tx,rootId);const[root]=await tx.select().from(storeOrder).where(eq(storeOrder.id,rootId)).limit(1).for('update');
  if(rootId!==id)await lockOrderSettlement(tx,id);
  const[order]=rootId===id?[root]:await tx.select().from(storeOrder).where(eq(storeOrder.id,id)).limit(1).for('update');
  if(!root||!order||hint.pid!==order.pid||order.uid!==root.uid||root.isSystemDel||root.isDel||order.isDel||order.isSystemDel||order.pid<0&&!(allowFulfilledHeader&&order.pid===-1&&order.id===root.id)||order.supplierAllocationStatus===1)throw new ValidateException('订单归属或可操作状态已变化');
  if(root.storeId!==order.storeId&&!(root.pid===-1&&root.supplierId===0&&root.supplierAllocationStatus===2))throw new ValidateException('订单父子门店归属不符');
  if(root.supplierId!==order.supplierId&&!(root.pid===-1&&root.supplierId===0&&root.supplierAllocationStatus===2))throw new ValidateException('订单父子供应商归属不符');return order;
}
export async function authorizeLockedCustomerOperation(tx:DbClient,p:PreparedCustomerOperation):Promise<CustomerWorkScope>{
  // The caller already owns the financial root and physical order locks.
  // Keep this actor account valid until the same write transaction commits.
  await authorizeCustomerOperationOwner(tx,p.actor);
  await acquireCustomerWorkScopeLock(tx,p.actor.uid);
  const scope=await authorizeCustomerWorkActor(tx,p.actor);
  if(scope.scope_key!==p.input.scope_key)throw new HttpApiException('手机订单管理身份已变化，请重新读取',403,403);
  return scope;
}
export async function appendCustomerOperation(tx:DbClient,p:PreparedCustomerOperation,serviceId:number,outcome:CustomerOperationOutcome,evidence:Record<string,CustomerJson>={}):Promise<CustomerOperationReceipt>{
  if(!Number.isSafeInteger(serviceId)||serviceId<0||!['abandoned','rollback-rejected',outcomes[p.kind]].includes(outcome)||(serviceId===0&&!['abandoned','rollback-rejected'].includes(outcome)))throw new ValidateException('工作台操作回执无效');
  const safe=freezeCustomerJson(evidence,16384),prior=await priorReceipt(tx,p);if(prior){if(prior.outcome!==outcome)throw new HttpApiException('原操作已留下确定回执，不能覆盖',409,409);return prior;}
  await tx.execute(sql`INSERT INTO public.customer_work_operation_request(actor_uid,request_key,request_hash,service_id,order_id,kind,outcome,scope_key,expected_revision,expected_fulfillment_revision,intent,evidence) VALUES(${p.actor.uid},${p.key}::uuid,${p.hash},${serviceId},${p.input.order_id},${p.kind},${outcome},${p.input.scope_key},${p.input.expected_order_revision},${p.input.expected_fulfillment_revision},${JSON.stringify(p.input)}::jsonb,${JSON.stringify(safe)}::jsonb)`);
  const result=await readReceipt(tx,p.actor.uid,p.key);if(!result)throw Error('Customer operation receipt did not persist');same(result,p);return result;
}
export class CustomerWorkOperationRequest {
  constructor(readonly container:Container){}
  async getOutcome(actorValue:CustomerWorkActor,keyValue:unknown){const actor=freezeCustomerActor(actorValue),key=normalizeOutRequestKey(keyValue);return withTx(this.container,async tx=>{await lockRequest(tx,actor.uid,key,false);await authorizeCustomerOperationOwner(tx,actor);return readReceipt(tx,actor.uid,key);});}
  async abandon(kind:CustomerOperationKind,ctx:CustomerOperationContext,input:unknown){const p=await prepareCustomerOperation(kind,ctx,input);return withTx(this.container,async tx=>{const prior=await priorReceipt(tx,p);await authorizeCustomerOperationOwner(tx,p.actor);return prior??appendCustomerOperation(tx,p,0,'abandoned');});}
  async localRejection(p:PreparedCustomerOperation,error:unknown):Promise<CustomerOperationResult|null>{
    if(!(error instanceof ValidateException||error instanceof NotFoundException||error instanceof AuthException||error instanceof HttpApiException&&[403,412].includes(error.httpStatus)))return null;
    return withTx(this.container,async tx=>{const prior=await priorReceipt(tx,p);await authorizeCustomerOperationOwner(tx,p.actor);return{receipt:prior??await appendCustomerOperation(tx,p,0,'rollback-rejected',{code:error instanceof HttpApiException?String(error.httpStatus):String(error.code)}),replayed:Boolean(prior)};});
  }
  async execute(kind:CustomerOperationKind,ctx:CustomerOperationContext,input:unknown,callback:(tx:DbClient,scope:CustomerWorkScope,order:Order,p:PreparedCustomerOperation)=>Promise<{outcome:CustomerOperationOutcome;evidence?:Record<string,CustomerJson>}>,beforeResourceFence?:(tx:DbClient)=>Promise<void>):Promise<CustomerOperationResult>{
    const p=await prepareCustomerOperation(kind,ctx,input);
    try{return await withTx(this.container,async tx=>{const prior=await priorReceipt(tx,p);if(prior){await authorizeCustomerOperationOwner(tx,p.actor);return{receipt:prior,replayed:true};}await beforeResourceFence?.(tx);const order=await lockCustomerWorkOrder(tx,p.input.order_id,p.kind==='remark'||p.kind.startsWith('waybill_')),scope=await authorizeLockedCustomerOperation(tx,p);const result=await callback(tx,scope,order,p);return{receipt:await appendCustomerOperation(tx,p,scope.service_id,result.outcome,result.evidence),replayed:false};});}
    catch(error){const rejected=await this.localRejection(p,error);if(rejected)return rejected;throw error;}
  }
}
