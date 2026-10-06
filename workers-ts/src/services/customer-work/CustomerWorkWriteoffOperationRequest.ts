import { sql } from 'drizzle-orm';
import { withTx,type Container,type DbClient } from '@/lib/di';
import { HttpApiException,ValidateException,NotFoundException,AuthException } from '@/utils/errors';
import { outRequestHash,normalizeOutRequestKey } from '@/services/out/OutIdempotency';
import { assertCustomerWriteoffOperationCatalog,customerWriteoffOperationReadiness } from '@/migrations/runCustomerWriteoffOperation';
import { authorizeCustomerOperationOwner,freezeCustomerActor,freezeCustomerJson,type CustomerJson } from './CustomerWorkOperationRequest';
import { acquireCustomerWorkScopeLock } from '@/migrations/runCustomerWorkScopeLock';
import { authorizeCustomerWorkActor,type CustomerWorkActor } from './CustomerWorkScope';
import { CUSTOMER_WRITEOFF_VERSION,CUSTOMER_WRITEOFF_REQUEST_NAMESPACE,prepareWriteoff,type WriteoffContext,type PreparedWriteoff,type WriteoffReceipt,type WriteoffOutcome } from './CustomerWorkWriteoffProtocol';

export async function lockWriteoffRequest(tx:DbClient,uid:number,key:string,write=true) {
 if(Object.hasOwn(tx,'$client'))throw Error('Customer writeoff ledger requires a caller-owned transaction');
 await assertCustomerWriteoffOperationCatalog(tx);await tx.execute(sql`LOCK TABLE public.customer_writeoff_operation_request IN ROW SHARE MODE NOWAIT`);await assertCustomerWriteoffOperationCatalog(tx);
 if(write&&!(await customerWriteoffOperationReadiness(tx)).ready)throw new HttpApiException('核销请求台账及实际权限尚未验收，请保留原请求核对',503,503);
 await tx.execute(sql`SET LOCAL row_security=off`);await tx.execute(sql`SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),10000)::text||'ms',true),set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1500)::text||'ms',true)`);
 const hash=await outRequestHash([uid,key]);await tx.execute(sql`SELECT pg_advisory_xact_lock(${CUSTOMER_WRITEOFF_REQUEST_NAMESPACE}::int,${parseInt(hash.slice(0,8),16)|0}::int)`);
}
export async function readWriteoffReceipt(db:DbClient,uid:number,key:string):Promise<WriteoffReceipt|null> {
 const rows=await db.execute<Omit<WriteoffReceipt,'version'|'request_key'>>(sql`SELECT actor_uid,service_id,order_id,request_hash,kind,outcome,evidence,floor(extract(epoch FROM created_at))::double precision AS created_at FROM public.customer_writeoff_operation_request WHERE actor_uid=${uid} AND request_key=${key}::uuid LIMIT 2`);
 if(rows.length>1)throw new HttpApiException('原核销回执身份重复，请人工核对',503,503);return rows[0]?{version:CUSTOMER_WRITEOFF_VERSION,request_key:key,...rows[0]}:null;
}
export function sameWriteoffReceipt(receipt:WriteoffReceipt,p:PreparedWriteoff) {if(receipt.actor_uid!==p.actor.uid||receipt.request_key!==p.key||receipt.request_hash!==p.hash||receipt.kind!==p.kind||receipt.order_id!==p.input.order_id)throw new HttpApiException('原请求键已经用于不同核销意图，请核对原操作',409,409);}
export async function checkWriteoffRequest(tx:DbClient,p:PreparedWriteoff){await lockWriteoffRequest(tx,p.actor.uid,p.key);const prior=await readWriteoffReceipt(tx,p.actor.uid,p.key);if(prior)sameWriteoffReceipt(prior,p);return prior;}
export async function authorizeWriteoffOperation(tx:DbClient,p:PreparedWriteoff){await authorizeCustomerOperationOwner(tx,p.actor);await acquireCustomerWorkScopeLock(tx,p.actor.uid);const scope=await authorizeCustomerWorkActor(tx,p.actor);if(scope.scope_key!==p.input.scope_key)throw new HttpApiException('手机核销身份已变化，请重新读取并确认',403,403);return scope;}
export async function appendWriteoffOperation(tx:DbClient,p:PreparedWriteoff,serviceId:number,outcome:WriteoffOutcome,evidence:Record<string,CustomerJson>):Promise<WriteoffReceipt>{
 const safe=freezeCustomerJson(evidence,262144),prior=await checkWriteoffRequest(tx,p);if(prior){if(prior.outcome!==outcome)throw new HttpApiException('原核销回执已经持久化，不能覆盖',409,409);return prior;}
 await tx.execute(sql`INSERT INTO public.customer_writeoff_operation_request(actor_uid,request_key,request_hash,service_id,order_id,kind,outcome,scope_key,expected_revision,expected_writeoff_revision,intent,evidence) VALUES(${p.actor.uid},${p.key}::uuid,${p.hash},${serviceId},${p.input.order_id},${p.kind},${outcome},${p.input.scope_key},${p.input.expected_order_revision},${p.input.expected_writeoff_revision},${JSON.stringify(p.input)}::jsonb,${JSON.stringify(safe)}::jsonb)`);
 const receipt=await readWriteoffReceipt(tx,p.actor.uid,p.key);if(!receipt)throw Error('The actual writeoff receipt did not persist');sameWriteoffReceipt(receipt,p);return receipt;
}
export class CustomerWorkWriteoffOperationRequest {
 constructor(readonly container:Container){}
 async original(actorValue:CustomerWorkActor,keyValue:unknown) {
  const actor=freezeCustomerActor(actorValue),key=normalizeOutRequestKey(keyValue);return withTx(this.container,async tx=>{await lockWriteoffRequest(tx,actor.uid,key,false);await authorizeCustomerOperationOwner(tx,actor);const receipt=await readWriteoffReceipt(tx,actor.uid,key);if(!receipt)return null;
   const rows=await tx.execute<{intent:unknown}>(sql`SELECT intent FROM public.customer_writeoff_operation_request WHERE actor_uid=${actor.uid} AND request_key=${key}::uuid LIMIT 2`);if(rows.length!==1)throw new HttpApiException('原核销请求无法核对',503,503);
   const p=await prepareWriteoff({actor,request_key:key},rows[0].intent);sameWriteoffReceipt(receipt,p);return{receipt,p};});
 }
 async abandon(context:WriteoffContext,input:unknown){const p=await prepareWriteoff(context,input);return withTx(this.container,async tx=>{const prior=await checkWriteoffRequest(tx,p);await authorizeCustomerOperationOwner(tx,p.actor);return{receipt:prior??await appendWriteoffOperation(tx,p,0,'abandoned',{}),replayed:Boolean(prior),execution:null};});}
 async reject(p:PreparedWriteoff,error:unknown){
  if(!(error instanceof ValidateException||error instanceof NotFoundException||error instanceof AuthException||error instanceof HttpApiException&&[403,412].includes(error.httpStatus)))return null;
  return withTx(this.container,async tx=>{const prior=await checkWriteoffRequest(tx,p);await authorizeCustomerOperationOwner(tx,p.actor);return{receipt:prior??await appendWriteoffOperation(tx,p,0,'rollback-rejected',{code:error instanceof HttpApiException?String(error.httpStatus):String(error.code)}),replayed:Boolean(prior),execution:null};});
 }
}
