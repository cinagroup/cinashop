import { eq, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeOrder, user } from '@/models/schema';
import { HttpApiException, ValidateException, NotFoundException } from '@/utils/errors';
import { normalizeOutRequestKey, outRequestHash } from '@/services/out/OutIdempotency';
import { lockOrderSettlement } from '@/services/order/OrderBrokerageService';
import { assertManagerOrderOperationCatalog, managerOperationReadiness } from '@/migrations/runManagerOrderOperation';
export { managerOperationReadiness } from '@/migrations/runManagerOrderOperation';
import { requireStoreManagerScope, merchantOrderRevision, managerId, type StoreManagerScope } from './StoreManagerScope';

export const MANAGER_OPERATION_VERSION = 'merchant-order-operation-v1' as const;
export type ManagerOperationKind = 'remark'|'manual_delivery'|'split_delivery'|'change_price'|'confirm_offline'|'refund_create'|'return_approve'|'refund_refuse'|'refund_execute';
export type ManagerOperationOutcome = 'remark-saved'|'delivery-recorded'|'price-changed'|'offline-paid'|'application-created'|'return-approved'|'refused'|'balance-settled'|'provider-admitted'|'abandoned'|'rollback-rejected';
export interface ManagerOrderActor { readonly uid:number; readonly authVersion:string; readonly expiresAt:number }
export interface ManagerOperationContext { readonly actor:ManagerOrderActor; readonly request_key:string }
export type ManagerJson = null|boolean|number|string|ManagerJson[]|{[key:string]:ManagerJson};
export interface ManagerOperationInput { readonly version:typeof MANAGER_OPERATION_VERSION; readonly store_id:number; readonly scope_key:string; readonly order_id:number; readonly expected_order_revision:string; readonly payload:ManagerJson }
export interface ManagerOperationReceipt { readonly version:typeof MANAGER_OPERATION_VERSION; readonly request_key:string; readonly request_hash:string; readonly actor_uid:number; readonly store_id:number; readonly staff_id:number; readonly order_id:number; readonly kind:ManagerOperationKind; readonly outcome:ManagerOperationOutcome; readonly evidence:Readonly<Record<string,ManagerJson>> }
export interface PreparedManagerOperation { readonly actor:ManagerOrderActor; readonly key:string; readonly hash:string; readonly kind:ManagerOperationKind; readonly input:ManagerOperationInput }
export interface ManagerOperationResult { receipt:ManagerOperationReceipt; replayed:boolean }
type Order = typeof storeOrder.$inferSelect;
const kinds=new Set<string>(['remark','manual_delivery','split_delivery','change_price','confirm_offline','refund_create','return_approve','refund_refuse','refund_execute']);
const hashes=/^[a-f0-9]{64}$/;
const outcomes:Record<ManagerOperationKind,readonly ManagerOperationOutcome[]>={remark:['remark-saved'],manual_delivery:['delivery-recorded'],split_delivery:['delivery-recorded'],change_price:['price-changed'],confirm_offline:['offline-paid'],refund_create:['application-created'],return_approve:['return-approved'],refund_refuse:['refused'],refund_execute:['balance-settled','provider-admitted']};
function validOutcome(kind:ManagerOperationKind,value:unknown):value is ManagerOperationOutcome{return value==='abandoned'||value==='rollback-rejected'||typeof value==='string'&&outcomes[kind].includes(value as ManagerOperationOutcome);}
function jsonCopy(value:unknown,depth=0):ManagerJson{
  if(depth>16)throw new ValidateException('操作内容层级过深');
  if(value===null||typeof value==='boolean'||typeof value==='string')return value;
  if(typeof value==='number'&&Number.isFinite(value)&&Number.isSafeInteger(value))return value;
  if(Array.isArray(value))return Object.freeze(value.map(row=>jsonCopy(row,depth+1))) as unknown as ManagerJson[];
  if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype){const record:Record<string,ManagerJson>={};for(const key of Object.keys(value).sort()){if(['__proto__','constructor','prototype'].includes(key))throw new ValidateException('操作字段无效');record[key]=jsonCopy((value as Record<string,unknown>)[key],depth+1);}return Object.freeze(record);}
  throw new ValidateException('操作内容不是有限JSON');
}
export function freezeManagerJson(value:unknown):ManagerJson{const copy=jsonCopy(value);if(new TextEncoder().encode(JSON.stringify(copy)).length>262144)throw new ValidateException('操作内容超过容量');return copy;}
export function managerActor(value:ManagerOrderActor):ManagerOrderActor{
  const uid=managerId(value?.uid,'用户');if(typeof value.authVersion!=='string'||!/^([a-f0-9]{32}|[a-f0-9]{64})$/.test(value.authVersion)||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=0)throw new ValidateException('管理会话无效');return Object.freeze({uid,authVersion:value.authVersion,expiresAt:value.expiresAt});
}
export async function prepareManagerOperation(kind:ManagerOperationKind,ctx:ManagerOperationContext,value:unknown):Promise<PreparedManagerOperation>{
  if(!kinds.has(kind))throw new ValidateException('管理操作种类无效');
  const actor=managerActor(ctx.actor),key=normalizeOutRequestKey(ctx.request_key),body=freezeManagerJson(value) as unknown as Record<string,unknown>;
  if(!body||Array.isArray(body)||Object.keys(body).sort().join(',')!=='expected_order_revision,order_id,payload,scope_key,store_id,version'||body.version!==MANAGER_OPERATION_VERSION||typeof body.store_id!=='number'||typeof body.order_id!=='number'||!Number.isSafeInteger(body.store_id)||!Number.isSafeInteger(body.order_id)||typeof body.scope_key!=='string'||typeof body.expected_order_revision!=='string'||!hashes.test(body.scope_key)||!hashes.test(body.expected_order_revision))throw new ValidateException('原管理操作合同无效');
  const input=Object.freeze({version:MANAGER_OPERATION_VERSION,store_id:managerId(body.store_id),order_id:managerId(body.order_id,'订单'),scope_key:String(body.scope_key),expected_order_revision:String(body.expected_order_revision),payload:body.payload as ManagerJson});
  return Object.freeze({actor,key,kind,input,hash:await outRequestHash({version:MANAGER_OPERATION_VERSION,actor_uid:actor.uid,kind,input})});
}
/** Current owner authentication is independent of mutable manager roles. It
 * permits only minimal receipt recovery after removal of those roles. */
export async function authorizeManagerOperationOwner(tx:DbClient,value:ManagerOrderActor){
  const actor=managerActor(value),now=Math.floor(Date.now()/1000);
  const rows=await tx.select({uid:user.uid,pwd:user.pwd,status:user.status,isDel:user.isDel,deleteTime:user.deleteTime,digest:sql<string>`md5(${user.pwd})`}).from(user).where(eq(user.uid,actor.uid)).limit(1).for('share',{noWait:true});
  if(actor.expiresAt<=now||rows.length!==1||rows[0].status!==1||rows[0].isDel!==0||rows[0].deleteTime!==null||rows[0].digest!==actor.authVersion)throw new HttpApiException('管理会话已失效，请重新登录后核对原操作',403,403);
}
async function lock(tx:DbClient,uid:number,key:string,write=true){
  if(Object.hasOwn(tx,'$client'))throw Error('Manager operation requires a caller-owned transaction');
  await assertManagerOrderOperationCatalog(tx);
  await tx.execute(sql`LOCK TABLE public.manager_order_operation_request IN ROW SHARE MODE NOWAIT`);
  if(write){const state=await managerOperationReadiness(tx);if(!state.ready)throw new HttpApiException('管理操作台账权限未验收，请保留原请求并核对',503,503);}
  await tx.execute(sql`SET LOCAL row_security=off`);
  await tx.execute(sql`SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1500)::text||'ms',true)`);
  const digest=await outRequestHash([uid,key]);await tx.execute(sql`SELECT pg_advisory_xact_lock(731625::int,${parseInt(digest.slice(0,8),16)|0}::int)`);
}
async function read(tx:DbClient,uid:number,key:string):Promise<ManagerOperationReceipt|null>{
  const rows=await tx.select({actor_uid:sql<number>`actor_uid`,store_id:sql<number>`store_id`,staff_id:sql<number>`staff_id`,order_id:sql<number>`order_id`,request_hash:sql<string>`request_hash`,kind:sql<string>`kind`,outcome:sql<string>`outcome`,evidence:sql<Record<string,ManagerJson>>`evidence`}).from(sql`public.manager_order_operation_request`).where(sql`actor_uid=${uid} AND request_key=${key}::uuid`).limit(2);
  if(!rows.length)return null;const row=rows[0];
  if(rows.length!==1||row.actor_uid!==uid||!kinds.has(row.kind)||!validOutcome(row.kind as ManagerOperationKind,row.outcome)||!hashes.test(row.request_hash)||!Number.isSafeInteger(row.staff_id)||row.staff_id<0||!row.evidence||Array.isArray(row.evidence))throw new HttpApiException('原管理操作回执异常，请人工核对',503,503);
  managerId(row.store_id);managerId(row.order_id);return Object.freeze({...row,kind:row.kind as ManagerOperationKind,outcome:row.outcome as ManagerOperationOutcome,version:MANAGER_OPERATION_VERSION,request_key:key,evidence:freezeManagerJson(row.evidence) as Readonly<Record<string,ManagerJson>>});
}
function same(prior:ManagerOperationReceipt,p:PreparedManagerOperation){if(prior.request_hash!==p.hash||prior.kind!==p.kind||prior.order_id!==p.input.order_id||prior.store_id!==p.input.store_id)throw new HttpApiException('原请求标识已绑定不同管理操作，不能更换原内容',409,409);}
export async function checkManagerOperation(tx:DbClient,p:PreparedManagerOperation){await lock(tx,p.actor.uid,p.key);const prior=await read(tx,p.actor.uid,p.key);if(prior)same(prior,p);return prior;}
/** Resource lock graph is shared by remark/fulfillment/payment/refund. Never
 * wait for user or role locks before acquiring the real order resource locks. */
export async function lockManagerOrder(tx:DbClient,orderId:number):Promise<Order>{
  const [candidate]=await tx.select({id:storeOrder.id,pid:storeOrder.pid}).from(storeOrder).where(eq(storeOrder.id,orderId)).limit(1);
  if(!candidate)throw new NotFoundException('订单不存在');const rootId=candidate.pid>0?candidate.pid:orderId;
  await lockOrderSettlement(tx,rootId);const[root]=await tx.select().from(storeOrder).where(eq(storeOrder.id,rootId)).limit(1).for('update');
  if(rootId!==orderId)await lockOrderSettlement(tx,orderId);
  const [order]=rootId===orderId?[root]:await tx.select().from(storeOrder).where(eq(storeOrder.id,orderId)).limit(1).for('update');
  if(!root||!order||order.pid!==candidate.pid||order.uid!==root.uid||order.pid<0||order.isDel||order.isSystemDel||order.supplierAllocationStatus===1)throw new ValidateException('订单归属或可操作状态已变化');return order;
}
export async function authorizeLockedManagerOperation(tx:DbClient,p:PreparedManagerOperation,order:Order,options:{skipRevision?:boolean}={}):Promise<StoreManagerScope>{
  await authorizeManagerOperationOwner(tx,p.actor);const scope=await requireStoreManagerScope(tx,p.actor.uid,p.input.store_id,{lock:true,expectedScopeKey:p.input.scope_key});
  if(order.id!==p.input.order_id||order.storeId!==scope.store_id||order.isDel||order.isSystemDel||order.supplierAllocationStatus===1||order.pid<0)throw new NotFoundException('订单不属于当前管理门店');
  if(!options.skipRevision&&await merchantOrderRevision(order)!==p.input.expected_order_revision)throw new HttpApiException('订单已变化，请核对原请求与最新订单',412,412);return scope;
}
export async function appendManagerOperation(tx:DbClient,p:PreparedManagerOperation,staffId:number,outcome:ManagerOperationOutcome,evidence:Record<string,ManagerJson>={}):Promise<ManagerOperationReceipt>{
  if(!validOutcome(p.kind,outcome)||!Number.isSafeInteger(staffId)||staffId<0)throw new ValidateException('管理回执结果无效');
  const safe=freezeManagerJson(evidence),prior=await checkManagerOperation(tx,p);if(prior){if(prior.outcome!==outcome)throw new HttpApiException('原操作已留下确定回执，不能覆盖',409,409);return prior;}
  await tx.execute(sql`INSERT INTO public.manager_order_operation_request(actor_uid,request_key,request_hash,store_id,staff_id,order_id,kind,outcome,scope_key,expected_revision,intent,evidence) VALUES(${p.actor.uid},${p.key}::uuid,${p.hash},${p.input.store_id},${staffId},${p.input.order_id},${p.kind},${outcome},${p.input.scope_key},${p.input.expected_order_revision},${JSON.stringify(p.input)}::jsonb,${JSON.stringify(safe)}::jsonb)`);
  const result=await read(tx,p.actor.uid,p.key);if(!result)throw Error('Manager operation receipt did not persist');same(result,p);return result;
}
export class ManagerOrderOperationRequest {
  constructor(readonly container:Container){}
  async getOutcome(actorInput:ManagerOrderActor,keyInput:unknown){const actor=managerActor(actorInput),key=normalizeOutRequestKey(keyInput);return withTx(this.container,async tx=>{await lock(tx,actor.uid,key,false);await authorizeManagerOperationOwner(tx,actor);return read(tx,actor.uid,key);});}
  async abandon(kind:ManagerOperationKind,ctx:ManagerOperationContext,input:unknown){const p=await prepareManagerOperation(kind,ctx,input);return withTx(this.container,async tx=>{const prior=await checkManagerOperation(tx,p);await authorizeManagerOperationOwner(tx,p.actor);return prior??appendManagerOperation(tx,p,0,'abandoned');});}
  /** Called only after the caller's short SQL transaction has rejected locally.
   * A committed admission always wins; external/SQL/commit errors stay unknown. */
  async localRejection(p:PreparedManagerOperation,error:unknown):Promise<ManagerOperationResult|null>{
    if(!(error instanceof ValidateException||error instanceof NotFoundException||error instanceof HttpApiException&&[403,412].includes(error.httpStatus)))return null;
    return withTx(this.container,async tx=>{const prior=await checkManagerOperation(tx,p);await authorizeManagerOperationOwner(tx,p.actor);return{receipt:prior??await appendManagerOperation(tx,p,0,'rollback-rejected',{code:error instanceof HttpApiException?String(error.httpStatus):String(error.code)}),replayed:Boolean(prior)};});
  }
  async execute(kind:ManagerOperationKind,ctx:ManagerOperationContext,input:unknown,callback:(tx:DbClient,scope:StoreManagerScope,order:Order)=>Promise<{outcome:ManagerOperationOutcome;evidence?:Record<string,ManagerJson>}>):Promise<ManagerOperationResult>{
    const p=await prepareManagerOperation(kind,ctx,input);
    try{return await withTx(this.container,async tx=>{const prior=await checkManagerOperation(tx,p);if(prior){await authorizeManagerOperationOwner(tx,p.actor);return{receipt:prior,replayed:true};}const order=await lockManagerOrder(tx,p.input.order_id),scope=await authorizeLockedManagerOperation(tx,p,order);const result=await callback(tx,scope,order);return{receipt:await appendManagerOperation(tx,p,scope.staff_id,result.outcome,result.evidence),replayed:false};});}
    catch(error){
      // Only a completed local validation rollback can produce rejection proof.
      // Network/commit ambiguity, SQL errors and timeouts stay unknown. Reacquire
      // the SAME key; any peer's committed outcome wins without replacement.
      const rejected=await this.localRejection(p,error);if(rejected)return rejected;throw error;
    }
  }
}
