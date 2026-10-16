import { sql } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DbClient } from '@/lib/di';
import { assertSupplierProductCopyOperationReady } from '@/migrations/supplierProductCopyOperation';
import { assertBoundedJson } from '@/services/admin/AdminLegacyProductInput';
import { productSaveCanonical, productSaveConflict } from '@/services/admin/AdminLegacyProductSaveState';
import type { SupplierVideoActor } from './SupplierVideoAuthority';
import { supplierCopyEditable, supplierCopyId } from './SupplierProductCopySource';
import { AuthException, ServiceUnavailableException, ValidateException } from '@/utils/errors';

export interface SupplierProductCopyReceipt {
  operation_id:string;actor_id:number;supplier_id:number;source_id:number|null;
  state:'unknown'|'committed'|'not_applied';result:null|{id:number;is_show:0;is_verify:0};
}
interface Row extends Omit<SupplierProductCopyReceipt,'source_id'|'state'> {
  source_id:number;state:'committed'|'not_applied';request_hash:string;created_at:number;
}
export interface SupplierProductCopyIntent {operationId:string;sourceId:number;token:string;requestHash:string;product:Record<string,unknown>}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function supplierCopyOperationId(value:unknown):string {
  if(typeof value!=='string'||!UUID.test(value))throw new ValidateException('复制操作ID须为小写UUIDv4');return value;
}
export function prepareSupplierProductCopy(value:unknown,sourceId:number,actor:SupplierVideoActor,appKey:string):SupplierProductCopyIntent {
  assertBoundedJson(value);supplierCopyId(sourceId);
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ValidateException('复制正文须为JSON对象');
  const body=value as Record<string,unknown>;
  if(Object.keys(body).length!==3||!['operation_id','copy_token','product'].every(k=>Object.hasOwn(body,k)))
    throw new ValidateException('复制仅接受操作ID、来源MAC与完整安全表单');
  const operationId=supplierCopyOperationId(body.operation_id),product=supplierCopyEditable(body.product);
  if(typeof body.copy_token!=='string'||!/^[a-f0-9]{64}$/.test(body.copy_token))throw new ValidateException('复制来源MAC无效');
  if(!appKey)throw new ServiceUnavailableException('供应商复制签名尚未就绪');
  const requestHash=createHmac('sha256',appKey).update('cinashop.supplier-product-copy.request.v1\0')
    .update(productSaveCanonical({operationId,sourceId,token:body.copy_token,actorId:actor.id,supplierId:actor.supplierId,product})).digest('hex');
  return {operationId,sourceId,token:body.copy_token,requestHash,product};
}
export function unknownSupplierCopyReceipt(operationId:string,actor:SupplierVideoActor):SupplierProductCopyReceipt {
  return {operation_id:operationId,actor_id:actor.id,supplier_id:actor.supplierId,source_id:null,state:'unknown',result:null};
}
function dto(row:Row):SupplierProductCopyReceipt {
  return {operation_id:row.operation_id,actor_id:row.actor_id,supplier_id:row.supplier_id,source_id:row.source_id,state:row.state,result:row.result};
}
export async function lockSupplierCopyOperation(tx:DbClient,operationId:string):Promise<void> {
  supplierCopyOperationId(operationId);
  const [held]=await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731743,hashtext(${operationId})) AS held`);
  if(held?.held!==true)throw productSaveConflict('原复制操作仍在处理，请查询原操作结果');
  await assertSupplierProductCopyOperationReady(tx);
}
export async function readSupplierCopyOperation(tx:DbClient,operationId:string,actor:SupplierVideoActor):Promise<Row|undefined> {
  supplierCopyOperationId(operationId);await assertSupplierProductCopyOperationReady(tx);
  const [row]=await tx.execute(sql`SELECT operation_id::text,actor_id,supplier_id,source_id,request_hash,state,result,created_at
    FROM public.supplier_product_copy_operation_v1 WHERE operation_id=${operationId}::uuid`) as unknown as Row[];
  if(!row)return;
  if(row.actor_id!==actor.id||row.supplier_id!==actor.supplierId)throw new AuthException('无权读取其他身份的复制操作',400011);
  const result=row.result;
  if(!Number.isSafeInteger(row.created_at)||row.created_at<=0||!Number.isSafeInteger(row.source_id)||row.source_id<=0
    ||!['committed','not_applied'].includes(row.state)
    ||row.state==='not_applied'&&(row.request_hash!==''||result!==null)
    ||row.state==='committed'&&(!/^[a-f0-9]{64}$/.test(row.request_hash)||!result||Object.keys(result).length!==3
      ||!Number.isSafeInteger(result.id)||result.id<=0||result.id>2147483647||result.is_show!==0||result.is_verify!==0))
    throw new ServiceUnavailableException('复制操作回执不完整');
  return row;
}
export async function replaySupplierCopyOperation(tx:DbClient,intent:SupplierProductCopyIntent,actor:SupplierVideoActor):Promise<SupplierProductCopyReceipt|undefined> {
  await lockSupplierCopyOperation(tx,intent.operationId);
  const row=await readSupplierCopyOperation(tx,intent.operationId,actor);
  if(!row)return;
  if(row.source_id!==intent.sourceId||row.state!=='committed'
    ||!timingSafeEqual(new TextEncoder().encode(row.request_hash),new TextEncoder().encode(intent.requestHash)))
    throw productSaveConflict('同一复制操作ID不能更改来源或正文，或已封存未执行');
  return dto(row);
}
export async function appendSupplierCopyOperation(tx:DbClient,operationId:string,sourceId:number,actor:SupplierVideoActor,
  now:number,requestHash:string,result:SupplierProductCopyReceipt['result']):Promise<SupplierProductCopyReceipt> {
  const expected:Row={operation_id:operationId,actor_id:actor.id,supplier_id:actor.supplierId,source_id:sourceId,
    request_hash:requestHash,state:result?'committed':'not_applied',result,created_at:now};
  const [saved]=await tx.execute(sql`INSERT INTO public.supplier_product_copy_operation_v1
    (operation_id,actor_id,supplier_id,source_id,request_hash,state,result,created_at)
    VALUES(${operationId}::uuid,${actor.id},${actor.supplierId},${sourceId},${requestHash},${expected.state},${result===null?null:JSON.stringify(result)}::jsonb,${now})
    RETURNING operation_id::text,actor_id,supplier_id,source_id,request_hash,state,result,created_at`) as unknown as Row[];
  if(productSaveCanonical(saved)!==productSaveCanonical(expected)
    ||productSaveCanonical(await readSupplierCopyOperation(tx,operationId,actor))!==productSaveCanonical(expected))
    throw productSaveConflict('复制回执完整回读不一致');
  return dto(expected);
}
export const supplierCopyReceiptDto=dto;
