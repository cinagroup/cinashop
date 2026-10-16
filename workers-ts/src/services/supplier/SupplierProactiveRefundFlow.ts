import {eq} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {capitalFlow,storeOrder,storeOrderRefund,user} from '@/models/schema';
import {outRequestHash} from '@/services/out/OutIdempotency';
import {supplierProactiveRefundConflict} from './SupplierProactiveRefundInput';
import {supplierProactiveRefundApplicationNumber} from './SupplierProactiveRefundIdentity';
import {readSupplierProactiveRefundDecision,type SupplierProactiveRefundOperation} from './SupplierProactiveRefundOperation';
type Flow=typeof capitalFlow.$inferSelect;
interface FlowObservation {eventKey:string;record:Flow|null}
const fact=(condition:unknown):void=>{if(!condition)throw supplierProactiveRefundConflict('主动退款实际资金流水无法核对');};
/** PHP CapitalFlowJob records only external weixin/alipay/offline payments.
 * Use this payout's amount, never the order's cumulative refunded amount.
 * Balance and cash are separate accounting channels and create no platform row. */
export async function recordSupplierProactiveRefundFlow(tx:DbClient,operation:SupplierProactiveRefundOperation,order:typeof storeOrder.$inferSelect,now:number):Promise<FlowObservation> {
 fact(!Object.hasOwn(tx,'$client')&&operation.state==='committed'&&operation.kind==='goods'&&operation.result
  &&operation.order_id===order.id&&operation.supplier_id===order.supplierId&&Number.isSafeInteger(now)&&now>0);
 const result=operation.result;if(!result)throw supplierProactiveRefundConflict();
 fact((await readSupplierProactiveRefundDecision(tx,operation))?.outcome==='local-settled');
 const original=operation.source?.order as Record<string,unknown>|undefined;
 fact(original&&['id','uid','supplierId','storeId','pid','paid','payType','payPrice','payTime','tradeNo','orderId'].every(key=>
  original[key]===(order as unknown as Record<string,unknown>)[key]));
 const [refund]=await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,result.refund_id!)).limit(1);
 fact(refund&&refund.storeOrderId===order.id&&refund.supplierId===order.supplierId&&refund.uid===order.uid
  &&refund.refundType===6&&refund.refundPrice===result.amount&&refund.refundedPrice===result.amount&&!refund.isCancel&&!refund.isDel);
 const eventKey=`supplier.proactive-refund:${operation.operation_id}`;
 if(result.amount==='0.00'||!['offline','weixin','alipay'].includes(order.payType)){
  const observation={eventKey,record:null};await verifySupplierProactiveRefundFlow(tx,observation);return observation;
 }
 const [buyer]=await tx.select().from(user).where(eq(user.uid,order.uid)).limit(1);fact(buyer||order.uid===0);
 const value={eventKey,
  flowId:supplierProactiveRefundApplicationNumber(operation.actor_id,operation.operation_id),orderId:order.orderId,
  storeId:order.storeId,uid:order.uid,nickname:buyer?.nickname??'游客',phone:buyer?.phone??'',price:`-${result.amount}`,
  tradingType:2,payType:order.payType,mark:`供应商主动退款 ${operation.operation_id}`,addTime:now};
 const inserted=await tx.insert(capitalFlow).values(value).onConflictDoNothing({target:capitalFlow.eventKey}).returning();
 fact(inserted.length<=1);
 const existing=inserted[0]??(await tx.select().from(capitalFlow).where(eq(capitalFlow.eventKey,value.eventKey)).limit(1))[0];
 fact(existing&&await outRequestHash(existing)===await outRequestHash({id:existing.id,...value}));return{eventKey,record:existing};
}
export async function verifySupplierProactiveRefundFlow(tx:DbClient,expected:FlowObservation) {
 const rows=await tx.select().from(capitalFlow).where(eq(capitalFlow.eventKey,expected.eventKey)).limit(2);
 fact(expected.record?rows.length===1&&await outRequestHash(rows[0])===await outRequestHash(expected.record):rows.length===0);
}
