import {sql} from 'drizzle-orm';
import {eq} from 'drizzle-orm';
import {storeOrderRefund} from '@/models/schema';
import {lockRefundExecution} from '@/services/order/StoreOrderRefundService';
import {withTx,type Container,type DbClient} from '@/lib/di';
import {HttpApiException,ValidateException,NotFoundException,AuthException} from '@/utils/errors';
import {normalizeOutRequestKey,outRequestHash} from '@/services/out/OutIdempotency';
import {assertCustomerFinancialOperationCatalog,customerFinancialOperationReadiness} from '@/migrations/runCustomerFinancialOperation';
import {acquireCustomerWorkScopeLock} from '@/migrations/runCustomerWorkScopeLock';
import {authorizeCustomerWorkActor,type CustomerWorkActor,type CustomerWorkScope} from './CustomerWorkScope';
import {authorizeCustomerOperationOwner,freezeCustomerActor,freezeCustomerJson,lockCustomerWorkOrder,type CustomerJson} from './CustomerWorkOperationRequest';
import {CUSTOMER_FINANCIAL_VERSION,prepareFinancialOperation,validateFinancialPayload,type FinancialRefundTarget,type FinancialContext,type FinancialInput,type FinancialKind,type FinancialOutcome,type FinancialReceipt,type PreparedFinancialOperation} from './CustomerWorkFinancialProtocol';

export async function lockFinancialRequest(tx:DbClient,uid:number,key:string,write=true){
 if(Object.hasOwn(tx,'$client'))throw Error('Financial ledger requires a caller-owned transaction');await assertCustomerFinancialOperationCatalog(tx);
 await tx.execute(sql`LOCK TABLE public.customer_financial_operation_request IN ROW SHARE MODE NOWAIT`);
 await assertCustomerFinancialOperationCatalog(tx);
 if(write&&!(await customerFinancialOperationReadiness(tx)).ready)throw new HttpApiException('手机订单财务台账及实际权限尚未验收',503,503);
 await tx.execute(sql`SET LOCAL row_security=off`);await tx.execute(sql`SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1500)::text||'ms',true)`);
 const digest=await outRequestHash([uid,key]);await tx.execute(sql`SELECT pg_advisory_xact_lock(731668::int,${parseInt(digest.slice(0,8),16)|0}::int)`);
}
export async function readFinancialReceipt(tx:DbClient,uid:number,key:string):Promise<FinancialReceipt|null>{
 const rows=await tx.execute<Omit<FinancialReceipt,'version'|'request_key'>>(sql`SELECT actor_uid,service_id,order_id,request_hash,kind,outcome,evidence,floor(extract(epoch FROM created_at))::double precision AS created_at FROM public.customer_financial_operation_request WHERE actor_uid=${uid} AND request_key=${key}::uuid LIMIT 2`);
 if(rows.length>1)throw new HttpApiException('原财务回执身份重复，请人工核对',503,503);return rows[0]?{version:CUSTOMER_FINANCIAL_VERSION,request_key:key,...rows[0]}:null;
}
export function sameFinancialReceipt(receipt:FinancialReceipt,p:PreparedFinancialOperation){if(receipt.request_hash!==p.hash||receipt.kind!==p.kind||receipt.order_id!==p.input.order_id)throw new HttpApiException('原请求键已用于不同财务意图，请核对原操作',409,409);}
export async function checkFinancialOperation(tx:DbClient,p:PreparedFinancialOperation){await lockFinancialRequest(tx,p.actor.uid,p.key);const prior=await readFinancialReceipt(tx,p.actor.uid,p.key);if(prior)sameFinancialReceipt(prior,p);return prior;}
export async function authorizeFinancialOperation(tx:DbClient,p:PreparedFinancialOperation):Promise<CustomerWorkScope>{await authorizeCustomerOperationOwner(tx,p.actor);await acquireCustomerWorkScopeLock(tx,p.actor.uid);const scope=await authorizeCustomerWorkActor(tx,p.actor);if(scope.scope_key!==p.input.scope_key)throw new HttpApiException('手机订单管理身份已变化，请重新读取并确认',403,403);return scope;}
export async function appendFinancialOperation(tx:DbClient,p:PreparedFinancialOperation,serviceId:number,outcome:FinancialOutcome,evidence:Record<string,CustomerJson>):Promise<FinancialReceipt>{
 const safe=freezeCustomerJson(evidence,16384),prior=await checkFinancialOperation(tx,p);if(prior){if(prior.outcome!==outcome)throw new HttpApiException('原财务回执已经持久化，不能覆盖',409,409);return prior;}
 await tx.execute(sql`INSERT INTO public.customer_financial_operation_request(actor_uid,request_key,request_hash,service_id,order_id,kind,outcome,scope_key,expected_revision,expected_financial_revision,intent,evidence) VALUES(${p.actor.uid},${p.key}::uuid,${p.hash},${serviceId},${p.input.order_id},${p.kind},${outcome},${p.input.scope_key},${p.input.expected_order_revision},${p.input.expected_financial_revision},${JSON.stringify(p.input)}::jsonb,${JSON.stringify(safe)}::jsonb)`);
 const receipt=await readFinancialReceipt(tx,p.actor.uid,p.key);if(!receipt)throw Error('Financial receipt did not persist');sameFinancialReceipt(receipt,p);return receipt;
}
export class CustomerWorkFinancialOperationRequest {
 constructor(readonly container:Container){}
 async outcome(actorValue:CustomerWorkActor,keyValue:unknown){const actor=freezeCustomerActor(actorValue),key=normalizeOutRequestKey(keyValue);return withTx(this.container,async tx=>{await lockFinancialRequest(tx,actor.uid,key,false);await authorizeCustomerOperationOwner(tx,actor);return readFinancialReceipt(tx,actor.uid,key);});}
 async original(actorValue:CustomerWorkActor,keyValue:unknown){const actor=freezeCustomerActor(actorValue),key=normalizeOutRequestKey(keyValue);return withTx(this.container,async tx=>{await lockFinancialRequest(tx,actor.uid,key,false);await authorizeCustomerOperationOwner(tx,actor);const receipt=await readFinancialReceipt(tx,actor.uid,key);if(!receipt)return null;const rows=await tx.execute<{intent:FinancialInput}>(sql`SELECT intent FROM public.customer_financial_operation_request WHERE actor_uid=${actor.uid} AND request_key=${key}::uuid LIMIT 2`);if(rows.length!==1)throw new HttpApiException('原财务请求无法核对',503,503);const p=await prepareFinancialOperation(receipt.kind,{actor,request_key:key},rows[0].intent);sameFinancialReceipt(receipt,p);return{receipt,p};});}
 async abandon(kind:FinancialKind,ctx:FinancialContext,value:unknown){const p=await prepareFinancialOperation(kind,ctx,value);return withTx(this.container,async tx=>{const prior=await checkFinancialOperation(tx,p);await authorizeCustomerOperationOwner(tx,p.actor);return{receipt:prior??await appendFinancialOperation(tx,p,0,'abandoned',{}),replayed:Boolean(prior),execution:null};});}
 async reject(p:PreparedFinancialOperation,error:unknown){if(!(error instanceof ValidateException||error instanceof NotFoundException||error instanceof AuthException||error instanceof HttpApiException&&[403,412].includes(error.httpStatus)))return null;return withTx(this.container,async tx=>{const prior=await checkFinancialOperation(tx,p);await authorizeCustomerOperationOwner(tx,p.actor);return{receipt:prior??await appendFinancialOperation(tx,p,0,'rollback-rejected',{code:error instanceof HttpApiException?String(error.httpStatus):String(error.code)}),replayed:Boolean(prior),execution:null};});}
 async local(kind:FinancialKind,ctx:FinancialContext,value:unknown,callback:(tx:DbClient,scope:CustomerWorkScope,p:PreparedFinancialOperation,order:Awaited<ReturnType<typeof lockCustomerWorkOrder>>)=>Promise<{outcome:FinancialOutcome;evidence:Record<string,CustomerJson>}>){const p=await prepareFinancialOperation(kind,ctx,value);try{return await withTx(this.container,async tx=>{const prior=await checkFinancialOperation(tx,p);if(prior){await authorizeCustomerOperationOwner(tx,p.actor);return{receipt:prior,replayed:true,execution:null};}
  // Match mature refund decisions: request -> refund advisory/row -> root/order
  // -> actor. A remark must never own the order while waiting for its refund.
  if(kind==='refund_remark'){const target=validateFinancialPayload(kind,p.input.payload) as FinancialRefundTarget;await lockRefundExecution(tx,target.refund_id);const refunds=await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,target.refund_id)).limit(2).for('update');if(refunds.length!==1||refunds[0].storeOrderId!==p.input.order_id||refunds[0].orderId!==target.refund_no)throw new NotFoundException('退款单号与实际申请归属不一致');}
  const order=await lockCustomerWorkOrder(tx,p.input.order_id,kind==='refund_remark'),scope=await authorizeFinancialOperation(tx,p),result=await callback(tx,scope,p,order);return{receipt:await appendFinancialOperation(tx,p,scope.service_id,result.outcome,result.evidence),replayed:false,execution:null};});}catch(error){const rejected=await this.reject(p,error);if(rejected)return rejected;throw error;}}
}
