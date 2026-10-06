import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, user, type OrderWaybillJob } from '@/models/schema';
import { lockOrderSettlement } from '@/services/order/OrderBrokerageService';
import { readCustomerWorkScope } from '@/services/customer-work/CustomerWorkScope';
import { acquireCustomerWorkScopeLock } from '@/migrations/runCustomerWorkScopeLock';
import { assertCustomerWorkOperationCatalog } from '@/migrations/runCustomerWorkOperation';
import { WaybillConfigurationError } from './CrmebOnePassWaybillProvider';
import { assertCustomerWaybillActorCatalog } from '@/migrations/runCustomerWaybillActor';

export interface CustomerWaybillActor { actorType:'customer'; actorId:number; serviceId:number }
export interface CustomerWaybillBinding { rootOrderId:number;orderId:number;storeId:number;supplierId:number;uid:number;rootStoreId:number;rootSupplierId:number;cartSnapshotHash?:string }
export class CustomerWaybillRevokedError extends WaybillConfigurationError {}
export function assertCustomerWaybillActor(actor:CustomerWaybillActor) {
  if(actor.actorType!=='customer'||![actor.actorId,actor.serviceId].every(v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647))
    throw new WaybillConfigurationError('手机经营面单身份无效');
}
export async function customerWaybillCartSnapshotHash(carts:readonly (typeof storeOrderCartInfo.$inferSelect)[]) {
  const bytes=new TextEncoder().encode(JSON.stringify([...carts].sort((a,b)=>a.id-b.id).map(c=>({id:c.id,oid:c.oid,uid:c.uid,
    cartId:c.cartId,cartNum:c.cartNum,splitSurplusNum:c.splitSurplusNum,splitStatus:c.splitStatus,cartInfo:c.cartInfo}))));
  const digest=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
/** Resource locks precede current principal/role locks. No inferred first
 * supplier-zero child and no mutable role check before waiting for an order. */
export async function lockCustomerWaybillOrder(tx:DbClient,binding:CustomerWaybillBinding,allowFulfilledReplay=false) {
  if(Object.hasOwn(tx,'$client'))throw Error('Customer waybill requires owned transaction');
  if(![binding.rootOrderId,binding.orderId,binding.uid].every(v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647)
    ||![binding.storeId,binding.supplierId,binding.rootStoreId,binding.rootSupplierId].every(v=>Number.isSafeInteger(v)&&v>=0&&v<=2147483647))
    throw new WaybillConfigurationError('手机经营面单订单边界无效');
  await lockOrderSettlement(tx,binding.rootOrderId);
  const [root]=await tx.select().from(storeOrder).where(eq(storeOrder.id,binding.rootOrderId)).limit(1).for('update',{noWait:true});
  if(binding.orderId!==binding.rootOrderId)await lockOrderSettlement(tx,binding.orderId);
  const [order]=binding.orderId===binding.rootOrderId?[root]:await tx.select().from(storeOrder).where(eq(storeOrder.id,binding.orderId)).limit(1).for('update',{noWait:true});
  if(!root||!order||root.uid!==binding.uid||order.uid!==binding.uid||order.storeId!==binding.storeId||order.supplierId!==binding.supplierId
    ||root.storeId!==binding.rootStoreId||root.supplierId!==binding.rootSupplierId
    ||root.pid>0||(order.id===root.id?!(order.pid===0||allowFulfilledReplay&&order.pid===-1):order.pid!==root.id)
    ||root.isDel||root.isSystemDel||order.isDel||order.isSystemDel||root.supplierAllocationStatus===1||order.supplierAllocationStatus===1)
    throw new WaybillConfigurationError('手机经营面单原订单边界已变化');
  return {root,order};
}
export async function authorizeCurrentCustomerWaybill(tx:DbClient,actor:CustomerWaybillActor) {
  assertCustomerWaybillActor(actor);
  const [account]=await tx.select({uid:user.uid}).from(user).where(and(eq(user.uid,actor.actorId),eq(user.status,1),eq(user.isDel,0),isNull(user.deleteTime)))
    .limit(1).for('share',{noWait:true});
  await acquireCustomerWorkScopeLock(tx,actor.actorId);
  const scope=account?await readCustomerWorkScope(tx,actor.actorId,false):null;
  if(!scope||scope.service_id!==actor.serviceId)throw new CustomerWaybillRevokedError('customer_authority_revoked_before_provider');
  return scope;
}
/** An asynchronous worker uses the durable admitted intent, never a fabricated
 * Admin actor or a queued bearer token. Every identity field is checked. */
export async function customerWaybillBindingFromReceipt(tx:DbClient,job:OrderWaybillJob):Promise<CustomerWaybillBinding> {
  await assertCustomerWaybillActorCatalog(tx);
  await assertCustomerWorkOperationCatalog(tx);
  const rows=await tx.execute<{service_id:number;kind:string;outcome:string;evidence:Record<string,unknown>}>(sql`
    SELECT service_id,kind,outcome,evidence FROM public.customer_work_operation_request
    WHERE actor_uid=${job.actorId} AND request_key=${job.requestKey}::uuid`);
  const row=rows[0],e=row?.evidence;
  if(rows.length!==1||row.service_id!==job.actorServiceId||row.outcome!=='provider-admitted'
    ||row.kind!==(job.fulfillmentMode==='split'?'electronic_split_waybill':'electronic_waybill')
    ||e?.waybill_job_id!==job.id||e.waybill_request_hash!==job.requestHash||e.root_order_id!==job.rootOrderId
    ||e.order_id!==job.orderId||e.store_id!==job.storeId||e.supplier_id!==job.supplierId
    ||!Number.isSafeInteger(e.customer_uid)||Number(e.customer_uid)<=0
    ||typeof e.waybill_cart_snapshot_hash!=='string'||!/^[a-f0-9]{64}$/.test(e.waybill_cart_snapshot_hash)
    ||![e.root_store_id,e.root_supplier_id].every(v=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=2147483647))
    throw new WaybillConfigurationError('手机经营面单持久授权回执不匹配');
  return {rootOrderId:job.rootOrderId,orderId:job.orderId,storeId:job.storeId,supplierId:job.supplierId,uid:Number(e.customer_uid),rootStoreId:Number(e.root_store_id),rootSupplierId:Number(e.root_supplier_id),cartSnapshotHash:e.waybill_cart_snapshot_hash};
}
