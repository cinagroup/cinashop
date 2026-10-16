import {eq,sql} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {storeOrder,storeOrderCartInfo,storeOrderRefund} from '@/models/schema';
import {storeOrderRefundSplit,storeOrderFulfillmentBranch} from '@/models/schema/order_refund_split';
import {refundEntityAcceptedPairSql} from '@/migrations/guestRefundEntityCatalog';
import {planOrderFinancialSplit} from '@/services/order/OrderSplitFinance';
import {loadUnpaidOrderGainIntegralProof} from '@/services/order/UnpaidOrderGainIntegralProof';
import {loadRefundOrderGeneration} from '@/services/order/RefundOrderGeneration';
import {loadRefundFulfillmentBranch} from '@/services/order/RefundFulfillmentBranch';
import {readRefundGenerationMarker,type RefundGenerationMarker} from '@/services/order/RefundGenerationMarker';
import {readRefundQuantityReservation,refundClaimCartKey} from '@/services/order/RefundQuantityReservation';
import {refundOrderSplitFingerprint} from '@/services/order/RefundOrderSplitIdentity';
import {outRequestHash} from '@/services/out/OutIdempotency';
import type {manualRefundWriteFacts} from '@/services/order/CustomerManualRefund';
import {loadSupplierOfflinePaymentOperation} from './SupplierOfflinePaymentOperation';
import {supplierManualRefundConflict} from './SupplierManualRefundInput';

type Order=typeof storeOrder.$inferSelect;type Cart=typeof storeOrderCartInfo.$inferSelect;type Refund=typeof storeOrderRefund.$inferSelect;
type ProofReader=(tx:DbClient,refund:Refund,order:Order)=>Promise<{source:{carts:unknown}}>;
const fact=(ok:unknown):void=>{if(!ok)throw supplierManualRefundConflict('供应商退款商品归属及原PHP购买来源无法核对');};
const object=(value:unknown):Record<string,unknown>=>{fact(value&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;};
function parse(value:string|null,maximum=65536):Record<string,unknown> {
  fact(typeof value==='string'&&new TextEncoder().encode(value!).length<=maximum);
  try{return object(JSON.parse(value!));}catch{throw supplierManualRefundConflict('供应商退款商品归属及原PHP购买来源无法核对');}
}
function rows(value:unknown,order:Order):Cart[] {
  fact(Array.isArray(value)&&value.length>0&&value.length<=200);
  const result=(value as unknown[]).map(raw=>{
    const row=object(raw);fact(Number.isSafeInteger(row.id)&&Number(row.id)>0&&row.oid===order.id&&row.uid===order.uid
      &&typeof row.cartId==='string'&&typeof row.cartInfo==='string'&&Number.isSafeInteger(row.cartNum)&&Number(row.cartNum)>0);
    parse(row.cartInfo as string);return row as Cart;
  });
  fact(new Set(result.map(row=>row.id)).size===result.length&&new Set(result.map(row=>row.cartId)).size===result.length);
  return result;
}
function rawPhp(carts:Cart[]):boolean {
  return carts.every(row=>{const info=parse(row.cartInfo);return !Object.hasOwn(info,'financial_version')
    &&info.productInfo&&typeof info.productInfo==='object'&&!Array.isArray(info.productInfo)
    &&object(info.productInfo).attrInfo&&typeof object(info.productInfo).attrInfo==='object'&&!Array.isArray(object(info.productInfo).attrInfo);});
}
async function plan(tx:DbClient,order:Order,carts:Cart[],selected=new Map(carts.map(row=>[row.cartId,row.cartNum]))) {
  fact(carts.every(row=>row.type===0&&row.relationId===0));
  const result=planOrderFinancialSplit({...order,refundPrice:'0.00',backIntegral:'0.00'},
    carts.map(row=>({...row,refundNum:0,splitStatus:0,splitSurplusNum:row.cartNum})),selected,
    await loadUnpaidOrderGainIntegralProof(tx,order,carts));
  fact(result&&result.legacyPhpProjection!==null);return result!;
}
function marker(carts:Cart[]):RefundGenerationMarker {
  const markers=carts.map(row=>readRefundGenerationMarker(parse(row.cartInfo).refund_order_generation));
  fact(markers.length>0&&markers.every(value=>JSON.stringify(value)===JSON.stringify(markers[0]))&&markers[0].role==='remaining');
  return markers[0];
}
// These purchase facts survive both refund and fulfillment partition writers.
// Mutable reservation/writeoff counters and generated row/unique identities do
// not authorize ownership; each new identity is traced through its ledger map.
const stable=['uid','type','relationId','productId','productType','skuUnique','promotionsId',
  'isGift','isSupportRefund','settlePrice','addTime'] as const;
interface RequiredLine {id:number;cartId:string;quantity:number;facts:Cart}
function samePurchase(required:RequiredLine,source:Cart,quantity:number) {
  fact(Number.isSafeInteger(quantity)&&quantity>0&&required.quantity<=quantity&&stable.every(key=>required.facts[key]===source[key]));
}
async function originalSupplierPhpPurchase(tx:DbClient,payment:Awaited<ReturnType<typeof manualRefundWriteFacts>>,order:Order) {
  if(!('payment_origin'in payment)||payment.payment_origin.kind!=='supplier_order_offline')return null;
  const origin=payment.payment_origin,receipt=await loadSupplierOfflinePaymentOperation(tx,origin.receipt.operation_id);
  fact(receipt?.state==='committed'&&receipt.source&&receipt.order_id===payment.root_id
    &&receipt.supplier_id===order.supplierId&&receipt.source.order.uid===order.uid);
  const {source,...reference}=receipt!;
  // Re-read and bind the full original source through the already verified
  // compact reference. Neither a mutable raw-looking cart nor its legacy tag
  // can replace what this actual Supplier originally collected payment for.
  fact(await outRequestHash(reference)===await outRequestHash(origin.receipt));
  const purchased=rows(source!.carts,source!.order);
  fact(rawPhp(purchased));fact((await plan(tx,source!.order,purchased)).legacyPhpProjection==='original-purchase');
  return{order:source!.order,carts:purchased};
}
function bindOriginalRawPurchase(original:Awaited<ReturnType<typeof originalSupplierPhpPurchase>>,order:Order,carts:Cart[]) {
  if(!original)return; // Genuine historical PHP payments have no new ledger.
  fact(original.order.id===order.id&&original.order.uid===order.uid&&original.order.supplierId===order.supplierId
    &&original.carts.length===carts.length);
  for(const row of carts) {
    const purchased=original.carts.find(source=>source.id===row.id&&source.cartId===row.cartId);
    fact(purchased&&purchased.cartNum===row.cartNum&&purchased.cartInfo===row.cartInfo&&purchased.unique===row.unique
      &&purchased.oldCartId===row.oldCartId&&purchased.writeTimes===row.writeTimes&&stable.every(key=>purchased[key]===row[key]));
  }
  // Paid activation and writeoff change SQL windows/counters/staff assignment,
  // not the purchase cartInfo bytes (SecondCardValidity/StoreOrderWriteoff).
}

/** A missing SQL owner is not legacy authority. Complete original PHP lines
 * remain readable; derived PHP lines must additionally trace every current
 * row through immutable refund/fulfillment mappings back to that raw purchase.
 * This does not relabel a checkout snapshot or rewrite any original evidence. */
export async function assertSupplierManualRefundLineOwnership(tx:DbClient,order:Order,carts:Cart[],payment:Awaited<ReturnType<typeof manualRefundWriteFacts>>,readProof:ProofReader) {
  if(carts.every(row=>row.type===2&&row.relationId===order.supplierId))return;
  fact(carts.every(row=>row.type===0&&row.relationId===0));
  const originalPurchase=await originalSupplierPhpPurchase(tx,payment,order),paymentRootId=payment.root_id;
  const current=await plan(tx,order,carts);
  if(rawPhp(carts)){fact(current.legacyPhpProjection==='original-purchase');bindOriginalRawPurchase(originalPurchase,order,carts);return;}
  fact(current.legacyPhpProjection==='refund-generation');
  const [catalog]=await tx.execute(sql.raw(refundEntityAcceptedPairSql(true)));
  fact(catalog?.profile==='legacy'||catalog?.profile==='guest');
  fact(await loadRefundOrderGeneration(tx,order,carts));
  let next=marker(carts),activeId=order.id,required:RequiredLine[]=carts.map(row=>({id:row.id,cartId:row.cartId,quantity:row.cartNum,facts:row}));
  const seen=new Set<string>();
  for(let depth=0;depth<201;depth++) {
    const identity=JSON.stringify(next);fact(!seen.has(identity));seen.add(identity);
    if('branchId'in next) {
      const records=await tx.select().from(storeOrderFulfillmentBranch).where(eq(storeOrderFulfillmentBranch.id,next.branchId)).limit(2);
      fact(records.length===1);const branch=records[0];
      fact(branch.childOrderId===activeId&&branch.uid===order.uid&&branch.supplierId===order.supplierId
        &&branch.storeId===order.storeId&&branch.paymentOrderId===paymentRootId);
      const verified=await loadRefundFulfillmentBranch(tx,{...order,id:activeId,pid:paymentRootId},next.branchId);
      const mapped=required.map(line=>{
        const part=verified.partitions.find(part=>part.rowId===line.id&&(!line.cartId||part.cartId===line.cartId));
        fact(part&&line.quantity<=part.quantity);return{...line,id:part!.sourceRowId};
      });
      fact(new Set(mapped.map(line=>line.id)).size===mapped.length);required=mapped;activeId=branch.sourceOrderId;
      // Parent cart catalogue keys are recovered from the next immutable
      // refund snapshot, not guessed from a freshly allocated child row PK.
      required=required.map(line=>({...line,cartId:''}));
      if(branch.sourceRefundId>0)next={refundId:branch.sourceRefundId,role:'remaining'};
      else{fact(branch.sourceBranchId);next={branchId:branch.sourceBranchId!,role:'remaining'};}
      continue;
    }
    const records=await tx.select({record:{refundId:storeOrderRefundSplit.refundId,fingerprint:storeOrderRefundSplit.fingerprint,
      remainingOrderId:storeOrderRefundSplit.remainingOrderId,disposition:storeOrderRefundSplit.disposition,
      uid:storeOrderRefundSplit.uid,supplierId:storeOrderRefundSplit.supplierId,storeId:storeOrderRefundSplit.storeId,
      paymentOrderId:storeOrderRefundSplit.paymentOrderId,sourceOrderId:storeOrderRefundSplit.sourceOrderId,
      partitions:sql<string|null>`CASE WHEN octet_length(${storeOrderRefundSplit.partitions})<=131072 THEN ${storeOrderRefundSplit.partitions} END`},
      snapshot:sql<string|null>`CASE WHEN octet_length(${storeOrderRefundSplit.sourceSnapshot})<=16777216 THEN ${storeOrderRefundSplit.sourceSnapshot} END`,
    }).from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId,next.refundId)).limit(2);
    fact(records.length===1);const {record,snapshot}=records[0];
    fact(record.remainingOrderId===activeId&&record.disposition==='split'&&record.uid===order.uid&&record.supplierId===order.supplierId
      &&record.storeId===order.storeId&&record.paymentOrderId===paymentRootId);
    const frozen=parse(snapshot,16777216),source=object(frozen.source) as Order;
    fact(frozen.version==='refund-order-materialization-v1'&&source.id===record.sourceOrderId&&source.uid===order.uid
      &&source.supplierId===order.supplierId&&source.storeId===order.storeId&&(source.pid||source.id)===paymentRootId);
    const original=rows(frozen.carts,source),applications=await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,record.refundId)).limit(2);
    fact(applications.length===1);const refund=applications[0],claim=readRefundQuantityReservation(refund);
    fact(refund.refundType===6&&!refund.isCancel&&!refund.isDel&&refund.storeOrderId===source.id&&refund.uid===order.uid
      &&refund.supplierId===order.supplierId&&refund.storeId===order.storeId&&await refundOrderSplitFingerprint(refund)===record.fingerprint&&claim);
    // Both manual realms independently prove their original complete source;
    // immutable partition rows alone never authorize a manufactured ancestor.
    fact(await outRequestHash((await readProof(tx,refund,source)).source.carts)===await outRequestHash(original));
    const selected=new Map(claim!.items.map(item=>[refundClaimCartKey(item),item.cartNum]));
    fact(typeof record.partitions==='string');
    const allocation=await plan(tx,source,original,selected),parts:unknown=JSON.parse(record.partitions!);
    fact(Array.isArray(parts)&&parts.length===original.length);
    const bySource=new Map<number,Record<string,unknown>>();
    for(const raw of parts as unknown[]) {
      const part=object(raw),row=original.find(row=>row.id===part.sourceRowId);
      fact(row&&!bySource.has(row.id)&&part.sourceCartId===row.cartId&&part.selectedNum===(selected.get(row.cartId)??0)
        &&part.remainingNum===row.cartNum-Number(part.selectedNum));
      bySource.set(row!.id,part);
    }
    required=required.map(line=>{
      const matches=original.filter(row=>bySource.get(row.id)?.remainingRowId===line.id);fact(matches.length===1);
      const row=matches[0],part=bySource.get(row.id)!;
      fact(!line.cartId||line.cartId===(record.sourceOrderId===activeId?row.cartId:String(line.id)));
      samePurchase(line,row,Number(part.remainingNum));return{id:row.id,cartId:row.cartId,quantity:line.quantity,facts:line.facts};
    });
    fact(new Set(required.map(line=>line.id)).size===required.length);
    if(rawPhp(original)){fact(allocation.legacyPhpProjection==='original-purchase');bindOriginalRawPurchase(originalPurchase,source,original);return;}
    fact(allocation.legacyPhpProjection==='refund-generation');activeId=source.id;next=marker(original);
  }
  fact(false);
}
