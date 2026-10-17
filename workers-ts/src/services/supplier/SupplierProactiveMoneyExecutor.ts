import {and,eq,sql} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {storeOrder,storeOrderStatus,user,userBill,capitalFlow,supplierTransactions} from '@/models/schema';
import {captureFinancialEffects,verifyFinancialCompletedRefund} from '@/services/customer-work/CustomerWorkFinancialVerification';
import {outRequestHash} from '@/services/out/OutIdempotency';
import {ServiceUnavailableException} from '@/utils/errors';
import {readBoundManualRefundProof} from './SupplierManualRefundProof';
import {assertSupplierVideoAuthority,type SupplierVideoActor} from './SupplierVideoAuthority';
import {supplierProactiveRefundApplicationNumber} from './SupplierProactiveRefundIdentity';
import {supplierProactiveRefundConflict,assertSupplierProactiveRefundCash,assertSupplierProactiveRefundRevision,supplierProactiveRefundMac,
 type SupplierProactiveRefundIntent} from './SupplierProactiveRefundInput';
import {appendSupplierProactiveRefundOperation,appendSupplierProactiveRefundDecision,type SupplierProactiveRefundOperation} from './SupplierProactiveRefundOperation';
import {readSupplierProactiveMoneyEvidence,makeSupplierProactiveMoneySource,appendSupplierProactiveMoneyCompletion,
 type SupplierProactiveMoneyCompletionProof} from './SupplierProactiveMoneyEvidence';
import {planSupplierProactiveMoneyRefund} from './SupplierProactiveRefundMoneyPlan';
import {readSupplierProactiveRefundSource} from './SupplierProactiveRefundSource';
type Source=Awaited<ReturnType<typeof readSupplierProactiveRefundSource>>;
const fact=(value:unknown):void=>{if(!value)throw supplierProactiveRefundConflict('原整单凭据、资金补退累计金额或实际效果无法核对');};
const cents=(value:string)=>BigInt(value.replace('.',''));
const decimal=(value:bigint)=>{const absolute=value<0n?-value:value;return `${value<0n?'-':''}${absolute/100n}.${String(absolute%100n).padStart(2,'0')}`;};
export async function verifiedSupplierProactiveMoneyEvidence(tx:DbClient,source:Source) {
 const evidence=await readSupplierProactiveMoneyEvidence(tx,source.order);
 await verifyFinancialCompletedRefund(tx,evidence.firstRefund,readBoundManualRefundProof,evidence.baseline);
 return evidence;
}
/** This executor never invokes a goods finalizer. The first goods receipt keeps
 * its original amount and all physical, point and supplier entitlement effects. */
export async function executeSupplierProactiveMoneyRefund(tx:DbClient,actorValue:SupplierVideoActor,intentValue:SupplierProactiveRefundIntent,
 requestHash:string,source:Source,now:number,appKey:string):Promise<SupplierProactiveRefundOperation> {
 const actor=Object.freeze({...actorValue}),intent=Object.freeze({...intentValue}),order=Object.freeze({...source.order});
 if(!['cash','offline','yue'].includes(order.payType))throw new ServiceUnavailableException('原渠道补退的持久回调与对账尚未就绪');
 fact(intent.type===1&&intent.order_id===order.id&&intent.supplier_id===order.supplierId&&order.supplierId===actor.supplierId);
 fact(intent.actor_id===actor.id&&requestHash===await outRequestHash(intent));
 await assertSupplierVideoAuthority(tx,actor,'supplier.order.manage');
 assertSupplierProactiveRefundCash(intent,order.payType==='yue'?'balance':'cash');
 // The coordinator already holds the live authority/order barriers and UUID
 // lock. Evidence tables remain append-only; their restricted LOGIN cannot
 // acquire a write-level table lock by gaining forbidden UPDATE privileges.
 const evidence=await verifiedSupplierProactiveMoneyEvidence(tx,source),plan=planSupplierProactiveMoneyRefund({paid:evidence.paid,
  firstGoodsRefund:evidence.first.amount,payType:order.payType as 'cash'|'offline'|'yue',
  completions:evidence.completions.map(row=>({operationId:row.operation_id,amount:row.amount,beforeRefunded:row.before_refunded,afterRefunded:row.after_refunded})),payments:[]},intent.refund_price);
 fact(plan.refunded===order.refundPrice&&plan.refunded===evidence.refunded);
 if(order.uid>0)fact((await tx.select().from(user).where(eq(user.uid,order.uid)).limit(1).for('update')).length===1);
 const before=await captureFinancialEffects(tx,order,evidence.firstRefund),
  moneySource=makeSupplierProactiveMoneySource(order,evidence,await outRequestHash(source)),
  businessNo=supplierProactiveRefundApplicationNumber(actor.id,intent.operation_id),eventKey=`supplier.proactive-refund:${intent.operation_id}`;
 fact(await outRequestHash(await readSupplierProactiveRefundSource(tx,order))===await outRequestHash(source));
 assertSupplierProactiveRefundRevision(intent.revision,supplierProactiveRefundMac(appKey,moneySource,actor));
 const operation=await appendSupplierProactiveRefundOperation(tx,{operationId:intent.operation_id,orderId:order.id,actor,now,intent,requestHash,source:moneySource,
  result:{order_id:order.id,refund_id:evidence.first.refund_id,amount:intent.refund_price,kind:'money',status:order.payType==='yue'?'BALANCE_SUCCESS':'CASH_SUCCESS'}});
 const written=await tx.update(storeOrder).set({refundPrice:plan.after_refunded,refundStatus:2,refundType:6}).where(and(eq(storeOrder.id,order.id),eq(storeOrder.supplierId,actor.supplierId),
  eq(storeOrder.refundPrice,plan.refunded),eq(storeOrder.refundStatus,order.refundStatus),eq(storeOrder.refundType,order.refundType))).returning();
 fact(written.length===1&&await outRequestHash(written[0])===await outRequestHash({...order,refundPrice:plan.after_refunded,refundStatus:2,refundType:6}));
 let bill:typeof userBill.$inferSelect|null=null;
 const priorBills=await tx.select().from(userBill).where(eq(userBill.linkId,businessNo)).limit(2);fact(priorBills.length===0);
 let expectedAccount=before.account;
 if(order.payType==='yue') {
  fact(before.account&&order.uid>0);
  const balance=decimal(cents(before.account!.nowMoney)+cents(intent.refund_price));
  const accounts=await tx.update(user).set({nowMoney:balance}).where(and(eq(user.uid,order.uid),eq(user.nowMoney,before.account!.nowMoney))).returning();
  expectedAccount={...before.account!,nowMoney:balance};fact(accounts.length===1&&await outRequestHash(accounts[0])===await outRequestHash(expectedAccount));
  const values={uid:order.uid,linkId:businessNo,pm:1,title:'商品退款',category:'now_money',type:'pay_product_refund',
   eventKey:'supplier_proactive_money_refund',number:intent.refund_price,balance,mark:`订单 ${order.orderId} 余款补退 ${intent.operation_id}`,addTime:now,status:1};
  const rows=await tx.insert(userBill).values(values).returning();fact(rows.length===1);bill=rows[0];
  fact(await outRequestHash(bill)===await outRequestHash({take:0,frozenTime:0,id:bill.id,...values}));
 }
 const transactionValue={supplierId:order.supplierId,uid:order.uid,orderId:businessNo,linkId:order.orderId,
  pm:0,type:2,payType:order.payType,payPrice:intent.refund_price,totalPrice:order.totalPrice,payPostage:'0.00',
  remark:'整单退货后的货款补退',mark:intent.operation_id,tradeTime:now,addTime:now};
 const [transaction]=await tx.insert(supplierTransactions).values(transactionValue).returning();fact(transaction);
 fact(await outRequestHash(transaction)===await outRequestHash({id:transaction.id,isDel:0,...transactionValue}));
 let flow:typeof capitalFlow.$inferSelect|null=null;
 fact((await tx.select().from(capitalFlow).where(eq(capitalFlow.eventKey,eventKey)).limit(2)).length===0);
 if(order.payType==='offline') {
  fact(before.account||order.uid===0);
  const value={eventKey,flowId:businessNo,orderId:order.orderId,storeId:order.storeId,uid:order.uid,
   nickname:before.account?.nickname??'游客',phone:before.account?.phone??'',price:`-${intent.refund_price}`,tradingType:2,payType:order.payType,
   mark:`供应商主动补退 ${intent.operation_id}`,addTime:now};
  const [row]=await tx.insert(capitalFlow).values(value).returning();fact(row);flow=row;
  fact(await outRequestHash(flow)===await outRequestHash({id:flow.id,...value}));
 }
 await tx.insert(storeOrderStatus).values({oid:order.id,changeType:'supplier_proactive_money_refund',
  changeMessage:`原请求 ${intent.operation_id} 补退 ${intent.refund_price} 元，累计 ${plan.after_refunded} 元`,changeTime:now});
 const proof:SupplierProactiveMoneyCompletionProof={version:'supplier-proactive-money-completion-v1',operation_id:intent.operation_id,
  actor_id:actor.id,supplier_id:actor.supplierId,order_id:order.id,first_refund_id:evidence.first.refund_id,payment_order_id:evidence.payment.id,
  amount:intent.refund_price,pay_type:order.payType as 'cash'|'offline'|'yue',source_hash:operation.source_hash,request_hash:requestHash,
  before_refunded:plan.refunded,after_refunded:plan.after_refunded,goods:evidence.first,
  bill:bill?{id:bill.id,hash:await outRequestHash(bill)}:null,flow:flow?{id:flow.id,hash:await outRequestHash(flow)}:null,
  supplier_transaction:{id:transaction.id,hash:await outRequestHash(transaction)}};
 await appendSupplierProactiveRefundDecision(tx,operation,{outcome:'local-settled',evidence:{refund_id:evidence.first.refund_id},now});
 await appendSupplierProactiveMoneyCompletion(tx,proof,now);
 await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
 // Read the full rows after deferred SQL writers. The monetary history leaf
 // verifies the actual bill, flow and transaction through canonical references.
 const current=(await tx.select().from(storeOrder).where(eq(storeOrder.id,order.id)).limit(1))[0];fact(current);
 const expectedOrder={...order,refundPrice:plan.after_refunded,refundStatus:2,refundType:6},payment=source.payment as Record<string,unknown>;
 if(payment.root_id===order.id&&Object.hasOwn(payment,'root'))fact(await outRequestHash(payment.root)===await outRequestHash(order));
 const expectedPayment=payment.root_id===order.id&&Object.hasOwn(payment,'root')?{...payment,root:expectedOrder}:source.payment;
 fact(await outRequestHash(await readSupplierProactiveRefundSource(tx,current))===await outRequestHash({...source,order:expectedOrder,payment:expectedPayment}));
 const after=await captureFinancialEffects(tx,current,evidence.firstRefund);
 fact(await outRequestHash(after)===await outRequestHash({...before,order:{...order,refundPrice:plan.after_refunded,refundStatus:2,refundType:6},account:expectedAccount}));
 fact(await outRequestHash((await tx.select().from(userBill).where(eq(userBill.linkId,businessNo)).limit(2)))===await outRequestHash(bill?[bill]:[]));
 const complete=await readSupplierProactiveMoneyEvidence(tx,current);
 fact(complete.refunded===plan.after_refunded&&complete.completions.some(row=>row.operation_id===intent.operation_id));
 await verifyFinancialCompletedRefund(tx,complete.firstRefund,readBoundManualRefundProof,complete.baseline);
 await assertSupplierVideoAuthority(tx,actor,'supplier.order.manage');
 return operation;
}
