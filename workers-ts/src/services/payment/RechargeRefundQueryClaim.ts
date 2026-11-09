/** Own-TX original-account GET claim. Never reissues POST, pays or releases money. */
import { createHash,randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import type { RechargeRefundRuntimeRole } from '@/migrations/rechargeRefund';
import { assertRechargeRoutineRefundAccountRuntimeTx } from '@/migrations/rechargeRoutineRefundAccount';
import { captureAdminRechargeRefundActor,authorizeAdminRechargeRefundTx,type AdminRechargeRefundActor } from '@/services/admin/AdminRechargeRefundActor';
import { ServiceUnavailableException } from '@/utils/errors';
import { authenticateRechargeRefundRecord,insertRechargeRefundEvidenceTx,lockRechargeRefundKeyTx } from './RechargeRefundLedger';
import { readRechargeRefundStateTx } from './RechargeRefundAccounting';
import { readRechargeRefundQueryHistoryTx } from './RechargeRefundQueryHistory';
import { rechargeRefundQueryClaimProjection } from './RechargeRefundQueryClaimProjection';
import { parseRechargeRefundQueryAttempt,type RechargeRefundQueryAttempt,type RechargeRefundQueryAttemptPayload } from './RechargeRefundQueryCodec';
import { rechargeRefundTransportApproval } from './RechargeRefundFirstRequest';
import { readRechargeRoutineRefundAccountPolicyTx,type RechargeRoutineRefundAccountRuntime } from './RechargeRoutineRefundAccount';
import { requireRechargeRoutineRefundPurpose } from './RechargeRoutineRefundAccountCodec';
import { routineCommittedMerchantMaterials } from './RoutineApprovedPaymentAccount';
import { routineEvidenceCanonical } from './RoutineProviderObservation';
type Runtime=RechargeRoutineRefundAccountRuntime;
const fail=():never=>{throw new ServiceUnavailableException('充值退款查询尚未到期或当前授权未完整就绪，请保留原操作');};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const same=(a:unknown,b:unknown)=>routineEvidenceCanonical(a)===routineEvidenceCanonical(b);
const brand:unique symbol=Symbol('committed-recharge-refund-query');
export interface PreparedRechargeRefundQuery {
 readonly operationId:string;readonly attemptId:string;readonly ordinal:number;readonly expiresAt:number;readonly role:RechargeRefundRuntimeRole;
 readonly [brand]:true;
}
const pending=new WeakMap<object,{binding:RechargeRefundQueryAttempt;appKey:string;root:DbClient;role:RechargeRefundRuntimeRole}>();
async function clock(tx:DbClient):Promise<number>{
 const [r]=await tx.execute<{now:string}>(sql`SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint AS now`);
 const n=Number(r?.now);if(!Number.isSafeInteger(n)||n<=0||n>2_147_483_587)return fail();return n;
}
async function context(tx:DbClient):Promise<void>{
 await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
 await tx.execute(sql`SELECT pg_catalog.set_config('statement_timeout',
  LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000),5000)::text||'ms',true),
  pg_catalog.set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000),1000)::text||'ms',true),
  pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true)`);
 const [r]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.current_setting('role')='none' AS ready`);
 if(r?.ready!==true)return fail();
}
async function claim(root:DbClient,inputEnv:Runtime,role:RechargeRefundRuntimeRole,operationId:unknown,inputActor?:AdminRechargeRefundActor):Promise<PreparedRechargeRefundQuery>{
 const client=Object.getOwnPropertyDescriptor(root,'$client');
 if(!client||!('value'in client)||!client.value||typeof client.value.begin!=='function'||!uuid(operationId)
  ||!['app','admin','financial'].includes(role)||(role==='admin')!==(inputActor!==undefined))return fail();
 const env:Runtime={APP_KEY:inputEnv.APP_KEY,ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:inputEnv.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS};
 const actor=inputActor===undefined?undefined:captureAdminRechargeRefundActor(inputActor);
 const admitted=await root.transaction(async raw=>{
  const tx=raw as unknown as DbClient;await context(tx);
  const scope=await assertRechargeRoutineRefundAccountRuntimeTx(tx,role,'write');
  if(actor)await authorizeAdminRechargeRefundTx(tx,actor);
  const rows=await tx.execute(sql`SELECT * FROM public.recharge_refund_operation WHERE operation_id=${operationId}::uuid LIMIT 2`);
  if(rows.length!==1)return fail();const op=authenticateRechargeRefundRecord(env,scope,'recharge_refund_operation',rows[0]);
  if(actor&&actor.id!==op.admin_id)return fail();
  await lockRechargeRefundKeyTx(tx,Number(op.admin_id),op.request_key);
  const locked=await readRechargeRefundStateTx(tx,op),h=await readRechargeRefundQueryHistoryTx(tx,env,role,operationId,'write');
  if(!same(op,h.operation)||!same(locked,h.state)||!same(scope,h.scope)||h.providerUniverse.disposition!=='unresolved')return fail();
  const basis=rechargeRefundQueryClaimProjection(h),issuedAt=await clock(tx);
  if(issuedAt<basis.nextQueryAt||issuedAt<basis.previousLeaseUntil)return fail();
  const pair=h.first.payload.approval;
  // Fresh current approval and current maintained credentials; past policy
  // references decoded by history are deliberately not reused as permission.
  const live=await readRechargeRoutineRefundAccountPolicyTx(tx,env,{appId:pair.appId,merchantId:pair.merchantId},'refund_query',role);
  requireRechargeRoutineRefundPurpose(live,'refund_query',issuedAt);
  const approval=rechargeRefundTransportApproval(live),attemptId=randomUUID(),leaseId=randomUUID();
  const q=h.first.payload.request;
  const payload:RechargeRefundQueryAttemptPayload={format:1,purpose:'recharge-refund-query-attempt-v1',scope,
   operationId,operationSignature:String(op.signature),firstAttemptId:String(h.first.attempt.attempt_id),
   firstAttemptSignature:String(h.first.attempt.signature),firstRequestHash:String(h.first.attempt.request_hash),firstIssuedAt:h.first.payload.issuedAt,
   ordinal:basis.nextOrdinal,approval,leaseId,issuedAt,leaseUntil:issuedAt+30,
   original:{outTradeNo:q.outTradeNo,transactionId:q.transactionId,outRefundNo:q.outRefundNo,refundAmount:q.refundAmount,totalAmount:q.totalAmount,currency:'CNY'},
   request:{method:'GET',path:'/v3/refund/domestic/refunds/'+encodeURIComponent(q.outRefundNo),body:null}};
  const hash=createHash('sha256').update(routineEvidenceCanonical({method:payload.request.method,path:payload.request.path,body:null,
   appId:approval.appId,merchantId:approval.merchantId})).digest('hex');
  const attempt=await insertRechargeRefundEvidenceTx(tx,env,role,'recharge_refund_attempt',{attempt_id:attemptId,operation_id:operationId,
   ordinal:basis.nextOrdinal,kind:'query',lease_id:leaseId,request_hash:hash,payload,created_at:issuedAt});
  const updated=await tx.execute(sql`UPDATE public.recharge_refund_state SET status='UNKNOWN',version=version+1,
   lease_id=${leaseId}::uuid,lease_until=${payload.leaseUntil},attempt_count=${basis.nextOrdinal},next_query_at=${issuedAt+60},updated_at=${issuedAt}
   WHERE operation_id=${operationId}::uuid AND status=${basis.previousStatus} AND wallet_state='held'
    AND version=${basis.previousVersion} AND attempt_count=${basis.totalAttempts} AND lease_id=${basis.previousLeaseId}::uuid
    AND lease_until=${basis.previousLeaseUntil} AND next_query_at=${basis.nextQueryAt} AND updated_at=${basis.updatedAt}
    AND last_result_id IS NULL AND provider_refund_id IS NULL RETURNING operation_id`);
  if(updated.length!==1||updated[0].operation_id!==operationId)return fail();
  const parsed=parseRechargeRefundQueryAttempt(env,scope,op,h.first.attempt,h.firstApproval,attempt,live);
  const state=await readRechargeRefundStateTx(tx,op),now=await clock(tx);
  const [deadline]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds'
   AND pg_catalog.current_setting('role')='none' AS ready`);
  requireRechargeRoutineRefundPurpose(live,'refund_query',now);
  if(state.status!=='UNKNOWN'||state.version!==basis.previousVersion+1||state.attempt_count!==basis.nextOrdinal
   ||state.wallet_state!=='held'||state.lease_id!==leaseId||state.lease_until!==payload.leaseUntil||state.next_query_at!==issuedAt+60
   ||state.last_result_id!==null||state.provider_refund_id!==null||state.updated_at!==issuedAt||now>=payload.leaseUntil
   ||actor&&actor.expiresAt<=now||deadline?.ready!==true)return fail();
  routineCommittedMerchantMaterials(env,{appId:approval.appId,merchantId:approval.merchantId,credentialRef:approval.credentialRef,
   credentialVersion:approval.credentialVersion,credentialStamp:approval.credentialStamp});
  return{binding:parsed,expiresAt:Math.min(payload.leaseUntil,live.payload.data.validUntil,actor?.expiresAt??payload.leaseUntil)};
 },{isolationLevel:'read committed',accessMode:'read write'});
 // COMMIT failure/unknown ACK cannot reach this minting point. Another caller
 // must re-read the committed tail and wait60s; it can never remint this GET.
 const token=Object.freeze({operationId,attemptId:String(admitted.binding.attempt.attempt_id),ordinal:admitted.binding.payload.ordinal,
  expiresAt:admitted.expiresAt,role,[brand]:true as const});
 pending.set(token,{binding:admitted.binding,appKey:env.APP_KEY,root,role});return token;
}
/** Internal service recovery, not a caller-selectable HTTP role. Actual LOGIN
 * is independently checked in this fresh transaction. No old AdminJWT needed. */
export function claimRechargeRefundServiceQuery(root:DbClient,env:Runtime,role:'app'|'financial',operationId:unknown):Promise<PreparedRechargeRefundQuery>{
 if(role!=='app'&&role!=='financial')return Promise.reject(new ServiceUnavailableException('充值退款查询运行身份无效'));
 return claim(root,env,role,operationId);
}
/** Current original Admin only; another Admin cannot adopt the original key. */
export function claimAdminRechargeRefundQuery(root:DbClient,env:Runtime,actor:AdminRechargeRefundActor,operationId:unknown):Promise<PreparedRechargeRefundQuery>{
 return claim(root,env,'admin',operationId,actor);
}
/** Private adapter handoff: burn before checking context/materials or RSA/I/O.
 * No current SQL data is returned to an HTTP DTO. This module sends nothing. */
export function consumeRechargeRefundQuery(root:DbClient,env:Pick<Env,'APP_KEY'|'ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS'>,
 role:RechargeRefundRuntimeRole,token:PreparedRechargeRefundQuery){
 const value=token&&typeof token==='object'?pending.get(token):undefined;if(!value)return fail();pending.delete(token);
 const now=Math.floor(Date.now()/1000);
 if(value.root!==root||value.role!==role||value.appKey!==env.APP_KEY||now<value.binding.payload.issuedAt-1||now>=token.expiresAt)return fail();
 const a=value.binding.payload.approval;
 return{binding:value.binding,materials:routineCommittedMerchantMaterials(env,{appId:a.appId,merchantId:a.merchantId,credentialRef:a.credentialRef,
  credentialVersion:a.credentialVersion,credentialStamp:a.credentialStamp}),rootDb:value.root,role:value.role};
}
