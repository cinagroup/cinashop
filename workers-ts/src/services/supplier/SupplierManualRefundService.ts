import { and,eq,sql } from 'drizzle-orm';
import { withTx,createContainerFromDb,type Container,type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { storeOrder,storeOrderRefund,storeOrderRefundPayment } from '@/models/schema';
import { assertSupplierManualRefundReady,lockSupplierManualRefundSources } from '@/migrations/supplierManualRefund';
import { StoreOrderRefundService } from '@/services/order/StoreOrderRefundService';
import { readRefundQuantityReservation } from '@/services/order/RefundQuantityReservation';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { captureFinancialEffects,verifyFinancialLocalRefund } from '@/services/customer-work/CustomerWorkFinancialVerification';
import { assertSupplierVideoAuthority,type SupplierVideoActor } from './SupplierVideoAuthority';
import { readSupplierManualRefundSource,prepareSupplierManualRefundExecution,readSupplierManualRefundProof,readBoundManualRefundProof } from './SupplierManualRefundProof';
import { parseSupplierManualRefundIntent,supplierManualRefundId,supplierManualRefundUuid,
  supplierManualRefundMoney,supplierManualRefundMac,assertSupplierManualRefundRevision,supplierManualRefundConflict,
  supplierManualRefundRecord } from './SupplierManualRefundInput';
import { NotFoundException,ServiceUnavailableException,ValidateException } from '@/utils/errors';
type Refund=typeof storeOrderRefund.$inferSelect;type Order=typeof storeOrder.$inferSelect;
export interface SupplierManualRefundResult {refund_id:number;order_id:number;amount:string;status:'CASH_SUCCESS'|'ZERO_SUCCESS'}
export interface SupplierManualRefundReceipt {operation_id:string;actor_id:number;supplier_id:number;refund_id:number|null;
  state:'unknown'|'not_applied'|'committed';result:SupplierManualRefundResult|null}
function failed(error:unknown):never {
  let cause=error;
  for(let i=0;i<8&&cause&&typeof cause==='object';i++) {
    const code='code'in cause?String(cause.code):'';
    if(['55P03','40P01','40001','23505'].includes(code))throw Object.assign(supplierManualRefundConflict(),{cause:error});
    if(['42501','42P01','42703','23514','57014'].includes(code))throw Object.assign(new ServiceUnavailableException('现金退款运行权限或维护协议尚未就绪，请核对原请求'),{cause:error});
    cause='cause'in cause?cause.cause:undefined;
  }
  throw error;
}
async function lockOperation(tx:DbClient,uuid:string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(731627,hashtext(${'supplier-manual-refund:'+uuid}))`);
}
async function operation(tx:DbClient,uuid:string) {
  const rows=await tx.execute<Record<string,unknown>>(sql`SELECT * FROM public.supplier_manual_refund_operation_v1 WHERE operation_id=${uuid}::uuid LIMIT 2`);
  if(rows.length>1)throw supplierManualRefundConflict();return rows[0];
}
function unknown(uuid:string,actor:SupplierVideoActor):SupplierManualRefundReceipt {
  return{operation_id:uuid,actor_id:actor.id,supplier_id:actor.supplierId,refund_id:null,state:'unknown',result:null};
}
async function receiptRow(row:Record<string,unknown>,actor:SupplierVideoActor):Promise<SupplierManualRefundReceipt> {
  if(row.actor_id!==actor.id||row.supplier_id!==actor.supplierId)throw supplierManualRefundConflict('原现金退款操作不属于当前登录身份');
  const base={operation_id:supplierManualRefundUuid(row.operation_id),actor_id:actor.id,supplier_id:actor.supplierId,refund_id:supplierManualRefundId(row.refund_id)};
  if(row.state==='not_applied') {
    if(row.intent!==null||row.result!==null||row.request_hash!==''||row.source_hash!==''||row.proof_hash!=='')throw supplierManualRefundConflict();
    return{...base,state:'not_applied',result:null};
  }
  if(row.state!=='committed')throw supplierManualRefundConflict();
  const intent=supplierManualRefundRecord(row.intent),result=supplierManualRefundRecord(row.result);
  if(await outRequestHash(intent)!==row.request_hash||intent.operation_id!==base.operation_id||intent.actor_id!==actor.id
    ||intent.supplier_id!==actor.supplierId||intent.refund_id!==base.refund_id||result.refund_id!==base.refund_id
    ||!['CASH_SUCCESS','ZERO_SUCCESS'].includes(String(result.status))||Object.keys(result).sort().join(',')!=='amount,order_id,refund_id,status')throw supplierManualRefundConflict();
  const amount=supplierManualRefundMoney(result.amount),id=supplierManualRefundId(result.order_id);
  if(amount!==intent.refund_price||(amount==='0.00'?result.status!=='ZERO_SUCCESS':result.status!=='CASH_SUCCESS')
    ||typeof row.source_hash!=='string'||!/^[a-f0-9]{64}$/.test(row.source_hash)||typeof row.proof_hash!=='string'||!/^[a-f0-9]{64}$/.test(row.proof_hash))throw supplierManualRefundConflict();
  return{...base,state:'committed',result:{refund_id:base.refund_id,order_id:id,amount,status:result.status as SupplierManualRefundResult['status']}};
}
async function current(tx:DbClient,refundId:number,actor:SupplierVideoActor) {
  const [refund]=await tx.select().from(storeOrderRefund).where(and(eq(storeOrderRefund.id,refundId),eq(storeOrderRefund.supplierId,actor.supplierId),
    sql`octet_length(to_jsonb(${storeOrderRefund})::text)<=262144`)).limit(1);
  const [order]=refund?await tx.select().from(storeOrder).where(and(eq(storeOrder.id,refund.storeOrderId),eq(storeOrder.supplierId,actor.supplierId),
    sql`octet_length(to_jsonb(${storeOrder})::text)<=262144`)).limit(1):[];
  if(!refund||!order)throw new NotFoundException('售后记录不存在或不属于当前供应商');
  if(order.paid!==1||order.isDel||order.isSystemDel||refund.isDel||refund.isCancel||order.supplierAllocationStatus===1
    ||refund.uid!==order.uid||refund.storeId!==order.storeId||!['cash','offline'].includes(order.payType))throw new ValidateException('当前订单不允许供应商现金退款');
  return{refund,order};
}
function eligible(refund:Refund) {
  if(![0,1,2,5].includes(refund.refundType)&&!(refund.refundType===4&&refund.applyType===3))throw new ValidateException('售后状态不支持本次现金退款');
  if(supplierManualRefundMoney(refund.refundedPrice)!=='0.00'||!readRefundQuantityReservation(refund))
    throw new ValidateException('售后已有资金处理或缺少实际商品数量凭据，请核对');
}
export class SupplierManualRefundService {
  constructor(private readonly container:Container,private readonly appKey:string,private readonly env:Env) {}
  private async transaction<T>(actorValue:SupplierVideoActor,write:boolean,capability:string|null,work:(tx:DbClient,actor:SupplierVideoActor)=>Promise<T>) {
    const actor=Object.freeze({...actorValue});
    try{return await withTx(this.container,async tx=>{
      await tx.execute(sql.raw(write?'SET TRANSACTION ISOLATION LEVEL READ COMMITTED':'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'));
      await tx.execute(sql`SELECT set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
        set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true)`);
      if(write)await tx.execute(sql`LOCK TABLE ONLY public.system_admin,ONLY public.system_supplier,ONLY public.system_role,ONLY public.system_menus IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
      await assertSupplierVideoAuthority(tx,actor,capability);await assertSupplierManualRefundReady(tx,write?'write':'read');
      const result=await work(tx,actor);await assertSupplierVideoAuthority(tx,actor,capability);return result;
    });}catch(error){return failed(error);}
  }
  async seed(refundId:number,actor:SupplierVideoActor) {
    supplierManualRefundId(refundId);
    return this.transaction(actor,false,'supplier.refund.view',async(tx,owner)=>{
      const{order,refund}=await current(tx,refundId,owner);eligible(refund);
      const source=await readSupplierManualRefundSource(tx,order,refund),amount=supplierManualRefundMoney(refund.refundPrice);
      return{refund_id:refund.id,order_id:order.id,refund_no:refund.orderId,refund_price:amount,pay_type:order.payType,
        settlement:amount==='0.00'?'zero' as const:'cash' as const,revision:supplierManualRefundMac(this.appKey,source,owner)};
    });
  }
  async execute(refundId:number,body:unknown,actor:SupplierVideoActor):Promise<SupplierManualRefundReceipt> {
    const identity=Object.freeze({...actor});
    const{intent,hash}=await parseSupplierManualRefundIntent(refundId,body,identity);
    return this.transaction(identity,true,null,async(tx,owner)=>{
      await lockOperation(tx,intent.operation_id);
      const prior=await operation(tx,intent.operation_id);
      if(prior) {
        const saved=await receiptRow(prior,owner);
        if(prior.state!=='committed'||prior.refund_id!==refundId||prior.request_hash!==hash)throw supplierManualRefundConflict();
        return saved;
      }
      await assertSupplierVideoAuthority(tx,owner,'supplier.refund.manage');
      // Physical barriers cover absent rows and late writers in the same lock
      // order as existing refund/settlement core. No external I/O occurs here.
      await tx.execute(sql`LOCK TABLE ONLY public.store_order,ONLY public.store_order_cart_info,ONLY public.store_order_refund IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
      await lockSupplierManualRefundSources(tx);
      const{order,refund}=await current(tx,refundId,owner);eligible(refund);
      if(refund.refundPrice!==intent.refund_price)throw supplierManualRefundConflict('执行金额须等于本售后实际已审查金额');
      const channels=await tx.select({id:storeOrderRefundPayment.id}).from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.refundId,refund.id)).limit(1);
      if(channels.length)throw supplierManualRefundConflict('已有支付渠道记录，不能确认现金返还');
      const source=await readSupplierManualRefundSource(tx,order,refund);
      assertSupplierManualRefundRevision(intent.revision,supplierManualRefundMac(this.appKey,source,owner));
      const cap=await prepareSupplierManualRefundExecution(tx,owner,intent,hash,order,refund);
      let before:Awaited<ReturnType<typeof captureFinancialEffects>>|undefined,verified=false;
      const check=async(db:DbClient,actualRefund:Refund,actualOrder:Order)=>{
        await assertSupplierVideoAuthority(db,owner,'supplier.refund.manage');
        if(actualRefund.id!==refund.id||actualRefund.orderId!==refund.orderId||actualOrder.id!==order.id
          ||actualOrder.supplierId!==owner.supplierId||actualRefund.supplierId!==owner.supplierId||actualOrder.uid!==order.uid
          ||actualRefund.refundPrice!==intent.refund_price||actualOrder.payType!==order.payType)throw supplierManualRefundConflict();
        assertSupplierManualRefundRevision(intent.revision,supplierManualRefundMac(this.appKey,await readSupplierManualRefundSource(db,actualOrder,actualRefund),owner));
        before=await captureFinancialEffects(db,actualOrder,actualRefund);
      };
      const executed=await new StoreOrderRefundService(createContainerFromDb(tx),this.env).agreeRefund(refund.id,{
        supplierManualRefund:cap,expectedSupplierId:owner.supplierId,expectedStoreId:order.storeId,expectedUid:order.uid,
        expectedStoreOrderId:order.id,expectedRefundOrderId:refund.orderId,expectedRefundAmountCents:Number(BigInt(intent.refund_price.replace('.',''))),
        expectedRefundedAmountCents:0,requireSystemVisible:true,requirePaid:true,authorizeLockedDecision:check,
        executionAudit:{changeType:'supplier_manual_refund',changeMessage:`供应商 ${owner.supplierId} / 管理员 ${owner.id} / 原请求 ${intent.operation_id} 确认现金退款`},
        recordLockedDecision:async(db,outcome)=>{
          if(outcome!=='balance-settled'||!before)throw supplierManualRefundConflict();
          await verifyFinancialLocalRefund(db,before,readBoundManualRefundProof);verified=true;
          await assertSupplierVideoAuthority(db,owner,'supplier.refund.manage');
        },
      });
      if(!executed.completed||!verified||!before)throw supplierManualRefundConflict('实际现金退款效果尚未核对');
      const [actual]=await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,refund.id)).limit(1);
      if(!actual)throw supplierManualRefundConflict();
      const proof=await readSupplierManualRefundProof(tx,actual,before.order);
      if(proof.operation_id!==intent.operation_id||proof.request_hash!==hash)throw supplierManualRefundConflict();
      const result:SupplierManualRefundResult={refund_id:refund.id,order_id:order.id,amount:intent.refund_price,status:intent.refund_price==='0.00'?'ZERO_SUCCESS':'CASH_SUCCESS'};
      await tx.execute(sql`INSERT INTO public.supplier_manual_refund_operation_v1(operation_id,actor_id,supplier_id,refund_id,request_hash,state,intent,source_hash,proof_hash,result,created_at)
        VALUES(${intent.operation_id}::uuid,${owner.id},${owner.supplierId},${refund.id},${hash},'committed',${JSON.stringify(intent)}::jsonb,
        ${proof.source_hash},${proof.proof_hash},${JSON.stringify(result)}::jsonb,floor(extract(epoch FROM clock_timestamp()))::integer)`);
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      // Deferred writers must not change an inventory/account delta after its
      // first verification inside the core. Recheck the original full before.
      await verifyFinancialLocalRefund(tx,before,readBoundManualRefundProof);
      const readback=await operation(tx,intent.operation_id);
      if(!readback||readback.request_hash!==hash||readback.source_hash!==proof.source_hash||readback.proof_hash!==proof.proof_hash)throw supplierManualRefundConflict();
      await assertSupplierVideoAuthority(tx,owner,'supplier.refund.manage');
      return receiptRow(readback,owner);
    });
  }
  async receipt(uuidValue:string,actor:SupplierVideoActor):Promise<SupplierManualRefundReceipt> {
    const uuid=supplierManualRefundUuid(uuidValue);
    return this.transaction(actor,false,null,async(tx,owner)=>{
      const row=await operation(tx,uuid);
      if(!row||row.actor_id!==owner.id||row.supplier_id!==owner.supplierId)return unknown(uuid,owner);
      return receiptRow(row,owner);
    });
  }
  async resolve(uuidValue:string,refundId:number,actor:SupplierVideoActor):Promise<SupplierManualRefundReceipt> {
    const uuid=supplierManualRefundUuid(uuidValue);supplierManualRefundId(refundId);
    return this.transaction(actor,true,null,async(tx,owner)=>{
      await lockOperation(tx,uuid);const prior=await operation(tx,uuid);
      if(prior){if(prior.refund_id!==refundId)throw supplierManualRefundConflict();return receiptRow(prior,owner);}
      const proof=await tx.execute(sql`SELECT refund_id FROM public.supplier_manual_refund_proof_v1 WHERE operation_id=${uuid}::uuid LIMIT 1`);
      if(proof.length)throw new ServiceUnavailableException('现金退款凭据存在但原回执缺失，不能认定未执行');
      await tx.execute(sql`INSERT INTO public.supplier_manual_refund_operation_v1(operation_id,actor_id,supplier_id,refund_id,request_hash,state,intent,source_hash,proof_hash,result,created_at)
       VALUES(${uuid}::uuid,${owner.id},${owner.supplierId},${refundId},'','not_applied',NULL,'','',NULL,floor(extract(epoch FROM clock_timestamp()))::integer)`);
      const saved=await operation(tx,uuid);if(!saved)throw supplierManualRefundConflict();return receiptRow(saved,owner);
    });
  }
}
