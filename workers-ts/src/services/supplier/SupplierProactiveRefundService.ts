import {and,asc,eq,sql} from 'drizzle-orm';
import {withTx,createContainerFromDb,type Container,type DbClient} from '@/lib/di';
import type {Env} from '@/env';
import {storeOrder,storeOrderCartInfo,storeOrderRefund} from '@/models/schema';
import {assertSupplierProactiveRefundReady} from '@/migrations/supplierProactiveRefund';
import {lockSupplierManualRefundSources} from '@/migrations/supplierManualRefund';
import {lockAtomicRefundOrder} from '@/services/order/RefundAtomicMaterialization';
import {applyOrderRefundWithMaterialization,StoreOrderRefundService} from '@/services/order/StoreOrderRefundService';
import {captureFinancialEffects,verifyFinancialLocalRefund} from '@/services/customer-work/CustomerWorkFinancialVerification';
import {outRequestHash} from '@/services/out/OutIdempotency';
import {NotFoundException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import {assertSupplierVideoAuthority,type SupplierVideoActor} from './SupplierVideoAuthority';
import {readSupplierProactiveRefundSource} from './SupplierProactiveRefundSource';
import {prepareSupplierProactiveRefundApplication} from './SupplierProactiveRefundCapability';
import {supplierProactiveRefundApplicationNumber} from './SupplierProactiveRefundIdentity';
import {parseSupplierProactiveRefundIntent,supplierProactiveRefundId,supplierProactiveRefundUuid,
 supplierProactiveRefundMac,assertSupplierProactiveRefundRevision,assertSupplierProactiveRefundCash,supplierProactiveRefundConflict,
 type SupplierProactiveRefundIntent} from './SupplierProactiveRefundInput';
import {readSupplierManualRefundSource,prepareSupplierProactiveManualRefundExecution,readBoundManualRefundProof} from './SupplierManualRefundProof';
import {parseSupplierManualRefundIntent,supplierManualRefundMac} from './SupplierManualRefundInput';
import {lockSupplierProactiveRefundOperation,readSupplierProactiveRefundOperation,appendSupplierProactiveRefundOperation,
 supplierProactiveRefundReceipt,unknownSupplierProactiveRefund,readSupplierProactiveRefundDecision,
 appendSupplierProactiveRefundDecision,type SupplierProactiveRefundOperation,type SupplierProactiveRefundReceipt,
 type SupplierProactiveRefundResult} from './SupplierProactiveRefundOperation';
import {recordSupplierProactiveRefundFlow,verifySupplierProactiveRefundFlow} from './SupplierProactiveRefundFlow';

type Order=typeof storeOrder.$inferSelect;
type Source=Awaited<ReturnType<typeof readSupplierProactiveRefundSource>>;
const fact=(condition:unknown):void=>{if(!condition)throw supplierProactiveRefundConflict();};
const cents=(amount:string)=>BigInt(amount.replace('.',''));
function failed(error:unknown):never {
 let cause=error;
 for(let i=0;i<8&&cause&&typeof cause==='object';i++) {
  const code='code'in cause?String(cause.code):'';
  if(['55P03','40P01','40001','23505'].includes(code))throw Object.assign(supplierProactiveRefundConflict(),{cause:error});
  if(['42501','42P01','42703','23514','57014'].includes(code))throw Object.assign(new ServiceUnavailableException('主动退款运行权限或维护协议尚未就绪，请核对原请求'),{cause:error});
  cause='cause'in cause?cause.cause:undefined;
 }
 throw error;
}
async function clock(tx:DbClient) {
 const [row]=await tx.execute<{now:number}>(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
 fact(row&&Number.isSafeInteger(row.now)&&row.now>0);return row.now;
}
async function current(tx:DbClient,id:number,actor:SupplierVideoActor,lock=false) {
 const [owned]=await tx.select().from(storeOrder).where(and(eq(storeOrder.id,id),eq(storeOrder.supplierId,actor.supplierId),
  sql`octet_length(to_jsonb(${storeOrder})::text)<=262144`)).limit(1);
 if(!owned)throw new NotFoundException('订单不存在或不属于当前供应商');
 const order=lock?await lockAtomicRefundOrder(tx,id):owned;
 fact(order.supplierId===actor.supplierId);
 const query=tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,id)).orderBy(asc(storeOrderCartInfo.id)).limit(201);
 const carts=await(lock?query.for('update'):query);
 return readSupplierProactiveRefundSource(tx,order,carts);
}
function common(source:Source,amount?:string) {
 const {order,refunds}=source,paid=cents(order.payPrice),refunded=cents(order.refundPrice);
 if(refunds.some(r=>!r.isCancel&&!r.isDel&&[0,1,2,4,5].includes(r.refundType)))throw new ValidateException('请先处理售后申请');
 if(paid<0n||refunded<0n||refunded>paid)throw supplierProactiveRefundConflict('订单累计退款金额无法核对');
 if(paid===0n) {
  if(![0,1].includes(order.refundStatus)||amount!==undefined&&amount!=='0.00')throw new ValidateException('零元订单不支持本次处理');
 } else if(refunded===paid)throw new ValidateException('已退完支付金额，不能再退款');
 if(amount!==undefined&&(paid>0n&&cents(amount)<=0n||cents(amount)>paid-refunded))throw new ValidateException('退款金额须为原付款剩余范围内的实际金额');
 return {paid,refunded,remaining:paid-refunded};
}
function wholeGoods(source:Source) {
 const {order,carts,refunds}=source;
 if(refunds.some(r=>r.refundType===6)||order.refundPrice!=='0.00'||order.backIntegral!=='0.00'
  ||carts.some(r=>r.refundNum!==0||!([0,1,2].includes(r.splitStatus))||(order.status===0
   ?r.splitStatus===2||r.splitSurplusNum!==r.cartNum
   :!((r.splitStatus<2&&r.splitSurplusNum===r.cartNum)||(r.splitStatus===2&&r.splitSurplusNum===0)))))
  throw new ServiceUnavailableException('商品已处理，资金余款须通过原整单完成凭据补退');
 fact(carts.length>0&&carts.reduce((n,r)=>n+r.cartNum,0)===order.totalNum);
}
function settlement(order:Order,amount:string) {
 return amount==='0.00'?'zero' as const:['cash','offline'].includes(order.payType)?'cash' as const:
  order.payType==='yue'?'balance' as const:'provider' as const;
}
async function completeReceipt(tx:DbClient,operation:SupplierProactiveRefundOperation,actor:SupplierVideoActor) {
 if(operation.state==='committed')fact(await readSupplierProactiveRefundDecision(tx,operation));
 return supplierProactiveRefundReceipt(operation,actor);
}

/** Order-ID proactive coordination. Every local effect, immutable operation and
 * decision commits together. Provider I/O needs its own durable coordinator;
 * a live Supplier capability is deliberately never serialized across phases. */
export class SupplierProactiveRefundService {
 constructor(private readonly container:Container,private readonly appKey:string,private readonly env:Env) {}
 private async transaction<T>(value:SupplierVideoActor,write:boolean,permission:string|null,work:(tx:DbClient,actor:SupplierVideoActor)=>Promise<T>) {
  const actor=Object.freeze({...value});
  try{return await withTx(this.container,async tx=>{
   await tx.execute(sql.raw(write?'SET TRANSACTION ISOLATION LEVEL READ COMMITTED':'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'));
   await tx.execute(sql`SELECT set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true)`);
   if(write)await tx.execute(sql`LOCK TABLE ONLY public.system_admin,ONLY public.system_supplier,ONLY public.system_role,ONLY public.system_menus IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
   await assertSupplierVideoAuthority(tx,actor,permission);await assertSupplierProactiveRefundReady(tx,write?'write':'read');
   const result=await work(tx,actor);await assertSupplierVideoAuthority(tx,actor,permission);return result;
  });}catch(error){return failed(error);}
 }
 async seed(orderId:number,actor:SupplierVideoActor) {
  supplierProactiveRefundId(orderId);
  return this.transaction(actor,false,'supplier.order.view',async(tx,owner)=>{
   const source=await current(tx,orderId,owner),budget=common(source);wholeGoods(source);
   const amount=`${budget.remaining/100n}.${String(budget.remaining%100n).padStart(2,'0')}`;
   return{title:'主动退款',action:`/order/refund/${orderId}`,method:'PUT' as const,order_id:orderId,order_no:source.order.orderId,
    refund_price:amount,paid:source.order.payPrice,refunded:source.order.refundPrice,pay_type:source.order.payType,
    settlement:settlement(source.order,amount),quantity:source.order.totalNum,kind:'goods' as const,
    revision:supplierProactiveRefundMac(this.appKey,source,owner),
    fields:[{field:'refund_price',label:'实际退款金额',type:'number',value:amount,precision:2,min:0,max:amount,required:true},
     {field:'type',label:'处理方式',type:'radio',value:1,options:[{value:1,label:'退款'},{value:2,label:'拒绝退款'}]}]};
  });
 }
 async execute(orderId:number,body:unknown,value:SupplierVideoActor):Promise<SupplierProactiveRefundReceipt> {
  const actor=Object.freeze({...value}),parsed=await parseSupplierProactiveRefundIntent(orderId,body,actor),{intent,hash}=parsed;
  return this.transaction(actor,true,null,async(tx,owner)=>{
   await lockSupplierProactiveRefundOperation(tx,intent.operation_id);
   const previous=await readSupplierProactiveRefundOperation(tx,intent.operation_id);
   if(previous) {
    const receipt=await completeReceipt(tx,previous,owner);
    fact(previous.state==='committed'&&previous.order_id===orderId&&previous.request_hash===hash);return receipt;
   }
   await assertSupplierVideoAuthority(tx,owner,'supplier.order.manage');
   await tx.execute(sql`LOCK TABLE ONLY public.store_order,ONLY public.store_order_cart_info,ONLY public.store_order_refund,
    ONLY public.store_order_invoice IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
   await lockSupplierManualRefundSources(tx);
   const source=await current(tx,orderId,owner,true);common(source,intent.refund_price);
   assertSupplierProactiveRefundRevision(intent.revision,supplierProactiveRefundMac(this.appKey,source,owner));
   assertSupplierProactiveRefundCash(intent,settlement(source.order,intent.refund_price));
   wholeGoods(source);
   if(intent.type===2)return this.refuse(tx,source,intent,hash,owner);
   if(settlement(source.order,intent.refund_price)==='provider')throw new ServiceUnavailableException('原渠道主动退款的持久回调与对账尚未就绪');
   const applied=await prepareSupplierProactiveRefundApplication(tx,owner,source.order,{phase:'application',...parsed});
   const created=await applyOrderRefundWithMaterialization(createContainerFromDb(tx),{uid:source.order.uid,orderId:source.order.orderId,
    privilegedActor:'supplier',selectorNamespace:'row',applyType:4,supplierProactiveRefundCapability:applied,
    cartSelections:source.carts.map(row=>({cartId:row.id,cartNum:row.cartNum})),
    requestedRefundAmountCents:Number(cents(intent.refund_price)),expectedRefundAmountCents:Number(cents(source.order.payPrice)),
    refundReason:'供应商主动整单退款',refundExplain:'按原付款实际金额返还，商品整单处理',
    applicationOrderId:supplierProactiveRefundApplicationNumber(owner.id,intent.operation_id),
    authorizeApplication:async(db,order)=>{fact(order.id===orderId&&order.supplierId===owner.supplierId);await assertSupplierVideoAuthority(db,owner,'supplier.order.manage');}},0);
   const [order]=await tx.select().from(storeOrder).where(eq(storeOrder.id,orderId));
   const [refund]=await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,created.refundId));fact(order&&refund);
   const result:SupplierProactiveRefundResult={order_id:orderId,refund_id:refund.id,amount:intent.refund_price,kind:'goods',
    status:intent.refund_price==='0.00'?'ZERO_SUCCESS':order.payType==='yue'?'BALANCE_SUCCESS':'CASH_SUCCESS'};
   // The original invoice reader needs this exact immutable source BEFORE
   // materialization. No operation can escape the outer transaction alone.
   const operation=await appendSupplierProactiveRefundOperation(tx,{operationId:intent.operation_id,orderId,actor:owner,
    now:await clock(tx),intent,requestHash:hash,source,result});
   const execution=await prepareSupplierProactiveRefundApplication(tx,owner,order,{phase:'execution',...parsed});
   let manual:Awaited<ReturnType<typeof prepareSupplierProactiveManualRefundExecution>>|undefined;
   if(['cash','offline'].includes(order.payType)) {
    const manualSource=await readSupplierManualRefundSource(tx,order,refund),request=await parseSupplierManualRefundIntent(refund.id,
     {operation_id:intent.operation_id,revision:supplierManualRefundMac(this.appKey,manualSource,owner),refund_price:intent.refund_price,
      ...(Object.hasOwn(intent,'cash_returned')?{cash_returned:true}:{})},owner);
    manual=await prepareSupplierProactiveManualRefundExecution(tx,execution,owner,request.intent,request.hash,order,refund);
   }
   const before=await captureFinancialEffects(tx,order,refund);let decided=false;
   const completed=await new StoreOrderRefundService(createContainerFromDb(tx),this.env).agreeRefund(refund.id,{
    supplierProactiveRefundCapability:execution,...manual?{supplierManualRefund:manual}:{},expectedSupplierId:owner.supplierId,
    expectedStoreId:order.storeId,expectedUid:order.uid,expectedStoreOrderId:orderId,expectedRefundOrderId:refund.orderId,
    expectedRefundAmountCents:Number(cents(intent.refund_price)),expectedRefundedAmountCents:0,requirePaid:true,requireSystemVisible:true,
    authorizeLockedDecision:async(db)=>{await assertSupplierVideoAuthority(db,owner,'supplier.order.manage');},
    executionAudit:{changeType:'supplier_proactive_refund',changeMessage:`供应商 ${owner.supplierId} / 管理员 ${owner.id} / 原请求 ${intent.operation_id} 主动退款`},
    recordLockedDecision:async(db,outcome)=>{
     fact(outcome==='balance-settled'&&!decided);
     await appendSupplierProactiveRefundDecision(db,operation,{outcome:'local-settled',evidence:{refund_id:refund.id},now:await clock(db)});
     await verifyFinancialLocalRefund(db,before,readBoundManualRefundProof);decided=true;
    }});
   fact(completed.completed&&decided);
   const flow=await recordSupplierProactiveRefundFlow(tx,operation,order,await clock(tx));
   await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
   await verifyFinancialLocalRefund(tx,before,readBoundManualRefundProof);await verifySupplierProactiveRefundFlow(tx,flow);
   await assertSupplierVideoAuthority(tx,owner,'supplier.order.manage');
   const stored=await readSupplierProactiveRefundOperation(tx,intent.operation_id);fact(stored);
   if(!stored)throw supplierProactiveRefundConflict();return completeReceipt(tx,stored,owner);
  });
 }
 private async refuse(tx:DbClient,source:Source,intent:SupplierProactiveRefundIntent,hash:string,actor:SupplierVideoActor) {
  const order=source.order,expected={...order,refundStatus:0,refundType:3};
  let expectedPayment=source.payment;
  const originalPayment=source.payment as Record<string,unknown>;
  // An online root order appears twice in the complete source. Prove that
  // both copies were the same full row, then project only this decision's two
  // state fields. An allocated child's distinct payment root stays exact.
  if(originalPayment.root_id===order.id&&Object.hasOwn(originalPayment,'root')) {
   fact(await outRequestHash(originalPayment.root)===await outRequestHash(order));
   expectedPayment={...originalPayment,root:expected};
  }
  const written=await tx.update(storeOrder).set({refundStatus:0,refundType:3}).where(and(eq(storeOrder.id,order.id),eq(storeOrder.supplierId,actor.supplierId))).returning();
  fact(written.length===1&&await outRequestHash(written[0])===await outRequestHash(expected));
  const result:SupplierProactiveRefundResult={order_id:order.id,refund_id:null,amount:intent.refund_price,kind:'refuse',status:'REFUSED'};
  const operation=await appendSupplierProactiveRefundOperation(tx,{operationId:intent.operation_id,orderId:order.id,actor,now:await clock(tx),intent,requestHash:hash,source,result});
  await appendSupplierProactiveRefundDecision(tx,operation,{outcome:'refused',evidence:{refund_id:null},now:await clock(tx)});
  await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  const actual=await current(tx,order.id,actor);
  fact(await outRequestHash(actual)===await outRequestHash({...source,order:expected,payment:expectedPayment}));
  await assertSupplierVideoAuthority(tx,actor,'supplier.order.manage');return completeReceipt(tx,operation,actor);
 }
 async receipt(value:string,actor:SupplierVideoActor):Promise<SupplierProactiveRefundReceipt> {
  const uuid=supplierProactiveRefundUuid(value);
  return this.transaction(actor,false,null,async(tx,owner)=>{
   const operation=await readSupplierProactiveRefundOperation(tx,uuid);
   if(!operation||operation.actor_id!==owner.id||operation.supplier_id!==owner.supplierId)return unknownSupplierProactiveRefund(uuid,owner);
   return completeReceipt(tx,operation,owner);
  });
 }
 async resolve(value:string,orderId:number,actor:SupplierVideoActor):Promise<SupplierProactiveRefundReceipt> {
  const uuid=supplierProactiveRefundUuid(value);supplierProactiveRefundId(orderId);
  return this.transaction(actor,true,null,async(tx,owner)=>{
   await lockSupplierProactiveRefundOperation(tx,uuid);
   const previous=await readSupplierProactiveRefundOperation(tx,uuid);
   if(previous){fact(previous.order_id===orderId);return completeReceipt(tx,previous,owner);}
   // A historical/incomplete application with this full UUID must never be
   // mislabeled as not applied. Recovery cannot create a replacement request.
   const orphan=await tx.select({id:storeOrderRefund.id}).from(storeOrderRefund)
    .where(eq(storeOrderRefund.orderId,supplierProactiveRefundApplicationNumber(owner.id,uuid))).limit(1);
   if(orphan.length)throw new ServiceUnavailableException('原主动退款申请存在但回执缺失，请核对原请求');
   const proofs=await tx.execute(sql`SELECT operation_id FROM public.supplier_manual_refund_proof_v1 WHERE operation_id=${uuid}::uuid LIMIT 1`);
   const money=await tx.execute(sql`SELECT operation_id FROM public.supplier_refund_money_payment_v1 WHERE operation_id=${uuid}::uuid
    UNION ALL SELECT operation_id FROM public.supplier_refund_money_completion_v1 WHERE operation_id=${uuid}::uuid LIMIT 1`);
   if(proofs.length||money.length)throw new ServiceUnavailableException('原主动退款资金凭据存在但回执缺失，请核对原请求');
   const saved=await appendSupplierProactiveRefundOperation(tx,{operationId:uuid,orderId,actor:owner,now:await clock(tx),intent:null,requestHash:'',source:null,result:null});
   return completeReceipt(tx,saved,owner);
  });
 }
}
