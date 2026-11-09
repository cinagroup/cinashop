/** Independent, immutable recharge refund approval maintenance and readers.
 * A current policy alone never supplies original payment, admin, wallet hold
 * or sole dispatch authority. No HTTP/transport or credential trial is here. */
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import type { RechargeRefundBinding, RechargeRefundRuntimeRole } from '@/migrations/rechargeRefund';
import { assertRechargeRoutineRefundAccountMaintenanceTx, assertRechargeRoutineRefundAccountRuntimeTx,
 inspectRechargeRoutineRefundAccountCatalog } from '@/migrations/rechargeRoutineRefundAccount';
import { ServiceUnavailableException } from '@/utils/errors';
import { captureRechargeRefundJson, captureRechargeRefundScope } from './RechargeRefundJournalCodec';
import { routineEvidenceCanonical } from './RoutineProviderObservation';
import { routinePaymentCredentialCommitment } from './RoutineApprovedPaymentAccount';
import { captureRechargeRoutineRefundAccountPolicy, parseRechargeRoutineRefundAccountJournal,
 rechargeRoutineRefundAccountId, requireRechargeRoutineRefundPurpose, signRechargeRoutineRefundAccountJournal,
 validateRechargeRoutineRefundAccountHistory, type RechargeRoutineRefundAccountJournal,
 type RechargeRoutineRefundPurpose } from './RechargeRoutineRefundAccountCodec';
export type RechargeRoutineRefundAccountRuntime=Pick<Env,'APP_KEY'|'ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS'>;
type Signing=Pick<Env,'APP_KEY'>;
const fail=():never=>{throw new ServiceUnavailableException('充值原账号退款批准或凭据未完整就绪');};
const same=(a:unknown,b:unknown)=>routineEvidenceCanonical(a)===routineEvidenceCanonical(b);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
function object(value:unknown,keys:readonly string[]):Record<string,unknown> {
 const r=captureRechargeRefundJson(value);
 if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).length!==keys.length||keys.some(k=>!Object.hasOwn(r,k)))return fail();
 return r as Record<string,unknown>;
}
async function clock(tx:DbClient):Promise<number> {
 const [row]=await tx.execute<{now:string}>(sql`SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint AS now`);
 const now=Number(row?.now);if(!Number.isSafeInteger(now)||now<=0||now>2_147_483_647)return fail();return now;
}
async function history(tx:DbClient,env:Signing,b:RechargeRefundBinding,accountId:string) {
 const rows=await tx.execute(sql`SELECT * FROM public.recharge_routine_refund_account_policy WHERE account_id=${accountId} ORDER BY revision LIMIT 65`);
 if(rows.length>64||Buffer.byteLength(JSON.stringify(rows),'utf8')>1_048_576)return fail();
 const records=Array.from(rows,row=>parseRechargeRoutineRefundAccountJournal(env,b,row));
 validateRechargeRoutineRefundAccountHistory(records,accountId);return records;
}
function commitment(env:RechargeRoutineRefundAccountRuntime,row:RechargeRoutineRefundAccountJournal) {
 const data=row.payload.data,m=routinePaymentCredentialCommitment(env,data.credentialRef,data.credentialVersion);
 if(m.appId!==data.appId||m.merchantId!==data.merchantId
  ||!timingSafeEqual(Buffer.from(m.credentialStamp,'hex'),Buffer.from(data.credentialStamp,'hex')))return fail();
}
/** SQL maintenance writer. Global UUID replay is checked before current secret
 * resolution, so credential retirement cannot erase a committed receipt.
 * Revocation needs no current merchant secret; it never rewrites old records. */
export async function appendRechargeRoutineRefundAccountPolicy(root:DbClient,env:RechargeRoutineRefundAccountRuntime,
 inputBinding:RechargeRefundBinding,input:unknown) {
 env={APP_KEY:env.APP_KEY,ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS};
 const b=captureRechargeRefundScope(inputBinding),r=object(input,['operationId','expectedRevision','data']);
 if(!uuid(r.operationId)||!Number.isSafeInteger(r.expectedRevision)||Number(r.expectedRevision)<0||Number(r.expectedRevision)>=64)return fail();
 const operationId=r.operationId,expectedRevision=Number(r.expectedRevision),data=captureRechargeRoutineRefundAccountPolicy(env,r.data);
 const client=Object.getOwnPropertyDescriptor(root,'$client');
 if(!client||!('value'in client)||!client.value||typeof client.value.begin!=='function')return fail();
 return root.transaction(async raw=>{
  const tx=raw as unknown as DbClient;await assertRechargeRoutineRefundAccountMaintenanceTx(tx,b);
  const catalog=await inspectRechargeRoutineRefundAccountCatalog(tx);if(!catalog.ready||!same(catalog.binding,b))return fail();
  const records=await history(tx,env,b,data.accountId);
  const [rawReplay]=await tx.execute(sql`SELECT * FROM public.recharge_routine_refund_account_policy WHERE record_id=${operationId}::uuid`);
  if(rawReplay) {
   const replay=parseRechargeRoutineRefundAccountJournal(env,b,rawReplay);
   if(replay.account_id!==data.accountId||replay.revision!==expectedRevision+1||!same(replay.payload.data,data)
    ||!records.some(row=>same(row,replay)))return fail();
   return Object.freeze({recordId:replay.record_id,revision:replay.revision,replayed:true});
  }
  const prior=records.at(-1),now=await clock(tx);
  if((prior?.revision??0)!==expectedRevision||prior&&now<prior.created_at||data.state==='active'&&now>=data.validUntil)return fail();
  const signed=signRechargeRoutineRefundAccountJournal(env,b,{record_id:operationId,account_id:data.accountId,revision:expectedRevision+1,
   payload:{format:1,purpose:'recharge_routine_refund_account',scope:b,previousRecordId:prior?.record_id??'',data},created_at:now});
  if(data.state==='active')commitment(env,signed);
  await tx.execute(sql`INSERT INTO public.recharge_routine_refund_account_policy(record_id,account_id,revision,payload,created_at,signature)
   VALUES(${signed.record_id}::uuid,${signed.account_id},${signed.revision},${JSON.stringify(signed.payload)}::jsonb,${signed.created_at},${signed.signature})`);
  const [saved]=await tx.execute(sql`SELECT * FROM public.recharge_routine_refund_account_policy WHERE record_id=${operationId}::uuid`);
  if(!same(parseRechargeRoutineRefundAccountJournal(env,b,saved),signed))return fail();
  return Object.freeze({recordId:operationId,revision:signed.revision,replayed:false});
 },{isolationLevel:'read committed',accessMode:'read write'});
}
/** Deterministic subject from the authenticated ORIGINAL pair, never current
 * global AppID or caller-selected account ID. Complete history is checked on
 * every fresh use, including records before revocation/credential rotation. */
export async function readRechargeRoutineRefundAccountPolicyTx(tx:DbClient,env:RechargeRoutineRefundAccountRuntime,
 inputPair:{appId:string;merchantId:string},purpose:RechargeRoutineRefundPurpose,role:RechargeRefundRuntimeRole,mode:'read'|'write'='write') {
 env={APP_KEY:env.APP_KEY,ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS};
 const pair=object(inputPair,['appId','merchantId']);
 const subject=rechargeRoutineRefundAccountId(env,pair.appId as string,pair.merchantId as string);
 const b=await assertRechargeRoutineRefundAccountRuntimeTx(tx,role,mode),records=await history(tx,env,b,subject),row=records.at(-1);
 if(!row)return fail();requireRechargeRoutineRefundPurpose(row,purpose,await clock(tx));commitment(env,row);
 return row;
}
/** Historical reference reader: independent of current credential registry or
 * policy expiry. It cannot create new provider/request/query authority. */
export async function readRechargeRoutineRefundAccountJournalTx(tx:DbClient,env:Signing,recordId:string,
 role:RechargeRefundRuntimeRole,mode:'read'|'write'='read') {
 if(!uuid(recordId))return fail();
 const b=await assertRechargeRoutineRefundAccountRuntimeTx(tx,role,mode);
 const [raw]=await tx.execute(sql`SELECT * FROM public.recharge_routine_refund_account_policy WHERE record_id=${recordId}::uuid`);
 const row=parseRechargeRoutineRefundAccountJournal(env,b,raw),records=await history(tx,env,b,row.account_id);
 if(!records.some(record=>same(record,row)))return fail();return row;
}
