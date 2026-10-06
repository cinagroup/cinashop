import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder,storeOrderCartInfo,storeOrderRefund,storePink,orderWaybillJob } from '@/models/schema';
import { presaleDispatchBoundary } from '@/services/activity/PresaleFulfillmentSnapshot';
import { loadRefundOrderGeneration,currentGenerationRefunds } from '@/services/order/RefundOrderGeneration';
import { ValidateException } from '@/utils/errors';
type Order=typeof storeOrder.$inferSelect;
export type CustomerFulfillmentMode='manual'|'split'|'electronic'|'city';
/** Caller owns root/target settlement locks. This is domain authority, independent
 * of Admin, supplier-login or Manager principals. Its locked variant also fences
 * absent refund/job/cart predicates NOWAIT; reads remain SELECT-only. */
export async function assertCustomerFulfillmentReady(tx:DbClient,state:{root:Order;order:Order},mode:CustomerFulfillmentMode,allowedWaybillJobId?:number,lock=true){
  const {root,order}=state,allocated=root.pid===-1&&root.supplierId===0&&root.supplierAllocationStatus===2;
  if(root.uid!==order.uid||root.isDel||root.isSystemDel||order.isDel||order.isSystemDel||order.pid<0||order.supplierAllocationStatus===1||(root.id!==order.id&&order.pid!==root.id)||!allocated&&(root.storeId!==order.storeId||root.supplierId!==order.supplierId))throw new ValidateException('履约根单与物理订单归属无效');
  if(order.paid!==1||order.status!==0||![0,3].includes(order.refundStatus))throw new ValidateException('订单付款、状态或售后状态不允许发货');
  if(![1,3].includes(order.shippingType))throw new ValidateException('当前订单须通过独立核销合同交付');
  if(![0,3].includes(order.productType))throw new ValidateException('当前商品须通过自动卡密或独立核销合同交付');
  if(mode!=='manual'&&order.productType===3)throw new ValidateException('手工虚拟商品须整单虚拟交付');
  if(mode==='electronic'&&(order.shippingType!==1||order.productType!==0)||mode==='city'&&(![1,3].includes(order.shippingType)||order.productType!==0))throw new ValidateException('当前订单不支持该配送渠道');
  if(lock)await tx.execute(sql`LOCK TABLE store_order_refund,order_waybill_job,store_order_cart_info IN SHARE MODE NOWAIT`);
  const cartQuery=tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id)).orderBy(asc(storeOrderCartInfo.id)).limit(501),carts=await(lock?cartQuery.for('share',{noWait:true}):cartQuery);
  if(!carts.length||carts.length>500||carts.some(c=>c.uid!==order.uid)||new Set(carts.map(c=>c.cartId)).size!==carts.length||!carts.some(c=>[0,1].includes(c.splitStatus)&&c.splitSurplusNum>0))throw new ValidateException('订单商品归属、唯一性或可发数量无效');
  for(const cart of carts)if(!cart.cartInfo||new TextEncoder().encode(cart.cartInfo).length>65536)throw new ValidateException('订单商品快照缺失或超限');
  const generation=await loadRefundOrderGeneration(tx,order,carts),refundQuery=tx.select().from(storeOrderRefund).where(and(eq(storeOrderRefund.storeOrderId,order.id),eq(storeOrderRefund.isCancel,0),eq(storeOrderRefund.isDel,0))).orderBy(asc(storeOrderRefund.id)).limit(501),refunds=await(lock?refundQuery.for('share',{noWait:true}):refundQuery);
  if(refunds.length>500)throw new ValidateException('订单售后历史超过容量');
  const current=await currentGenerationRefunds(refunds,generation);if(current.some(r=>[0,1,2,4,5].includes(r.refundType)))throw new ValidateException('订单存在进行中的售后');
  const jobs=await tx.select({id:orderWaybillJob.id}).from(orderWaybillJob).where(and(eq(orderWaybillJob.rootOrderId,root.id),inArray(orderWaybillJob.status,['PENDING','ENQUEUING','ENQUEUED','PROCESSING','RETRYABLE','UNKNOWN','DEAD']))).limit(2);
  if(jobs.some(job=>job.id!==allowedWaybillJobId))throw new ValidateException('订单存在未結电子面单任务，请先核对');
  if(order.type===3){const pinkQuery=tx.select({status:storePink.status}).from(storePink).where(eq(storePink.id,order.pinkId)).limit(1),pink=await(lock?pinkQuery.for('share',{noWait:true}):pinkQuery);if(pink[0]?.status!==2)throw new ValidateException('拼团尚未成功，不能发货');}
  if(order.type===6){const boundary=Math.max(...carts.map(c=>presaleDispatchBoundary(c.cartInfo,c.productId))),[clock]=await tx.execute<{ready:boolean}>(sql`SELECT clock_timestamp()>=to_timestamp(${boundary}) AS ready`);if(clock?.ready!==true)throw new ValidateException('预售活动尚未结束，不能发货');}
  return carts;
}
