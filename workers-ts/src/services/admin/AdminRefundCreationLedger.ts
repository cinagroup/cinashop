import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { HttpApiException } from '@/utils/errors';
import { normalizeOutRequestKey, outRequestHash } from '@/services/out/OutIdempotency';
import { ADMIN_REFUND_CREATION_VERSION, refundCreationId } from './AdminRefundCreationProtocol';

export interface RefundCreationIdentity { readonly adminId:number;readonly requestKey:string;readonly requestHash:string;readonly orderId:number }
export type RefundCreationReceipt=RefundCreationIdentity & {readonly version:typeof ADMIN_REFUND_CREATION_VERSION} &
  ({readonly outcome:'created';readonly refundId:number}|{readonly outcome:'abandoned';readonly refundId:null});
const invalid=()=>new HttpApiException('主动退款创建回执异常，请人工核对',503,503);
function identity(value:RefundCreationIdentity):RefundCreationIdentity {
  refundCreationId(value.adminId);refundCreationId(value.orderId);
  if(typeof value.requestHash!=='string' || !/^[a-f0-9]{64}$/.test(value.requestHash))throw invalid();
  return Object.freeze({...value,requestKey:normalizeOutRequestKey(value.requestKey)});
}
/** Same global lock order as execution: current actor -> original key -> order.
 * Separate key namespace/table: creation precedes and identifies a refund ID. */
export async function readRefundCreation(tx:DbClient,adminId:number,requestKey:unknown):Promise<RefundCreationReceipt|null> {
  if(Object.hasOwn(tx,'$client'))throw Error('Creation ledger requires a business transaction');
  refundCreationId(adminId);const key=normalizeOutRequestKey(requestKey);
  await tx.execute(sql`SET LOCAL row_security = off`);
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1500)::text || 'ms',true)`);
  const hash=await outRequestHash([adminId,key]);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(731609::int,${Number.parseInt(hash.slice(0,8),16)|0}::int)`);
  const rows=await tx.select({orderId:sql<unknown>`order_id`,refundId:sql<unknown>`refund_id`,requestHash:sql<unknown>`request_hash`,outcome:sql<unknown>`outcome`})
    .from(sql`admin_refund_creation`).where(sql`admin_id=${adminId} AND request_key=${key}::uuid`).limit(2);
  if(!rows.length)return null;
  const r=rows[0];
  if(rows.length!==1 || typeof r.orderId!=='number' || !Number.isSafeInteger(r.orderId) || r.orderId<=0 || r.orderId>2147483647
    || typeof r.requestHash!=='string' || !/^[a-f0-9]{64}$/.test(r.requestHash))throw invalid();
  const base:RefundCreationIdentity & {readonly version:typeof ADMIN_REFUND_CREATION_VERSION}=
    {version:ADMIN_REFUND_CREATION_VERSION,adminId,requestKey:key,requestHash:r.requestHash,orderId:r.orderId};
  if(r.outcome==='abandoned' && r.refundId===null)return Object.freeze({...base,outcome:'abandoned',refundId:null});
  if(r.outcome==='created' && typeof r.refundId==='number' && Number.isSafeInteger(r.refundId) && r.refundId>0 && r.refundId<=2147483647)
    return Object.freeze({...base,outcome:'created',refundId:r.refundId});
  throw invalid();
}
export async function checkRefundCreation(tx:DbClient,value:RefundCreationIdentity) {
  const original=identity(value),prior=await readRefundCreation(tx,original.adminId,original.requestKey);
  if(prior && (prior.requestHash!==original.requestHash || prior.orderId!==original.orderId))throw new HttpApiException('原创建标识已用于不同退款内容',409,409);
  return prior;
}
export async function appendRefundCreation(tx:DbClient,value:RefundCreationIdentity,refundId:number|null):Promise<RefundCreationReceipt> {
  const original=identity(value),prior=await checkRefundCreation(tx,original);
  if(refundId!==null)refundCreationId(refundId);
  const outcome=refundId===null?'abandoned':'created';
  if(prior){if(prior.outcome!==outcome || prior.refundId!==refundId)throw new HttpApiException('创建操作已有回执，不能覆盖',409,409);return prior;}
  await tx.execute(sql`INSERT INTO admin_refund_creation(admin_id,request_key,request_hash,order_id,refund_id,outcome)
    VALUES(${original.adminId},${original.requestKey}::uuid,${original.requestHash},${original.orderId},${refundId},${outcome})`);
  const receipt=await readRefundCreation(tx,original.adminId,original.requestKey);
  if(!receipt || receipt.requestHash!==original.requestHash || receipt.orderId!==original.orderId || receipt.refundId!==refundId || receipt.outcome!==outcome)throw invalid();
  return receipt;
}
