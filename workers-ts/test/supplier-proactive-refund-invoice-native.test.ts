import {supplierProactiveRefundApplicationNumber} from '@/services/supplier/SupplierProactiveRefundIdentity';
/** Owned PG16 invoice SQL acceptance. Money/payment/refund state is produced by
 * actual checkout, Supplier collection, paid consumer and refund core. Only the
 * unissued application is maintenance input; no provider/red-note is faked. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {createContainerFromDb,withTx,type DbClient} from '@/lib/di';
import {storeOrder,storeOrderCartInfo,storeOrderInvoice,storeOrderRefund,systemRole,user} from '@/models/schema';
import {installSupplierProactiveRefund} from '@/migrations/supplierProactiveRefund';
import {applyOrderRefundWithMaterialization,StoreOrderRefundService} from '@/services/order/StoreOrderRefundService';
import {prepareRefundInvoice,materializeRefundInvoice} from '@/services/order/RefundInvoiceAllocation';
import {assertStoredManualInvoiceAllocation,assertStoredSupplierProactiveInvoiceAllocation,SUPPLIER_WHOLE_INVOICE_VERSION} from '@/services/order/InvoiceManualRedNoteEvidence';
import {captureFinancialEffects,verifyFinancialLocalRefund,verifyFinancialMaterializedRefund} from '@/services/customer-work/CustomerWorkFinancialVerification';
import {prepareSupplierProactiveRefundApplication} from '@/services/supplier/SupplierProactiveRefundCapability';
import {readSupplierProactiveRefundSource} from '@/services/supplier/SupplierProactiveRefundSource';
import {prepareSupplierProactiveManualRefundExecution,readSupplierManualRefundSource,readBoundManualRefundProof} from '@/services/supplier/SupplierManualRefundProof';
import {parseSupplierProactiveRefundIntent,supplierProactiveRefundJson} from '@/services/supplier/SupplierProactiveRefundInput';
import {parseSupplierManualRefundIntent,supplierManualRefundMac} from '@/services/supplier/SupplierManualRefundInput';
import {outRequestHash} from '@/services/out/OutIdempotency';
import {supplierManualRefundFixture} from './helpers/supplierManualRefund';
import {supplierOrderEditActor,supplierOrderEditAppKey} from './helpers/supplierUnpaidOrderEdit';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual Supplier whole-invoice first-goods concessions',()=>{
 let f:Awaited<ReturnType<typeof supplierManualRefundFixture>>;
 type Runtime=Parameters<Parameters<typeof f.withManualRuntime>[0]>[0];
 const actor=()=>supplierOrderEditActor();
 beforeEach(async()=>{vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No provider traffic in owned invoice acceptance'));f=await supplierManualRefundFixture();},120000);
 afterEach(async()=>{try{await f?.close();}finally{vi.restoreAllMocks();}},30000);
 async function paidInvoice(){
  const created=await f.createOffline(),id=created.id;
  await f.service.save(id,{...await f.body(id),pay_price:'18.75',gain_integral:'17'},actor());
  await f.withPaymentRuntime(async(_runtime,payment)=>payment.pay(id,await f.paymentBody(id,payment),actor()));
  await f.consumePaid(id);
  const [invoice]=await f.db.insert(storeOrderInvoice).values({orderId:id,uid:11,category:'order',isPay:1,isRefund:0,isInvoice:0,
   invoiceAmount:'18.75',name:'实际未开票申请',remark:'完整原票保持',addTime:Math.floor(Date.now()/1000)}).returning();
  if(!invoice)throw Error('Actual unissued invoice missing');return {id,invoice};
 }
 async function commissioned<T>(work:(runtime:Runtime)=>Promise<T>){
  return f.withManualRuntime(async runtime=>{
   await f.db.transaction(tx=>installSupplierProactiveRefund(tx,{runtimeRole:runtime.role}));
   await f.db.update(systemRole).set({rules:'supplier.order.manage'}).where(eq(systemRole.id,21));return work(runtime);
  });
 }
 const snapshot=async()=>({...await f.manualSnapshot(),invoices:await f.db.select().from(storeOrderInvoice).orderBy(storeOrderInvoice.id),
  proactive:await f.exec('SELECT * FROM public.supplier_proactive_refund_operation_v1 ORDER BY operation_id'),
  decisions:await f.exec('SELECT * FROM public.supplier_proactive_refund_decision_v1 ORDER BY operation_id')});
 async function application(tx:DbClient,id:number){
  const [order]=await tx.select().from(storeOrder).where(eq(storeOrder.id,id));
  const carts=await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,id)).orderBy(storeOrderCartInfo.id);
  if(!order)throw Error('Actual paid order absent');
  const source=await readSupplierProactiveRefundSource(tx,order,carts),parsed=await parseSupplierProactiveRefundIntent(id,
   {operation_id:randomUUID(),revision:'a'.repeat(64),refund_price:'7.00',cash_returned:true},actor());
  const cap=await prepareSupplierProactiveRefundApplication(tx,actor(),order,{phase:'application',...parsed});
  const created=await applyOrderRefundWithMaterialization(createContainerFromDb(tx),{uid:order.uid,orderId:order.orderId,
   privilegedActor:'supplier',selectorNamespace:'row',applyType:4,supplierProactiveRefundCapability:cap,
   cartSelections:carts.map(row=>({cartId:row.id,cartNum:row.cartNum})),requestedRefundAmountCents:700,expectedRefundAmountCents:1875,
   refundReason:'整单商品返还，首退实际现金7.00',refundExplain:'owned actual invoice acceptance',
   applicationOrderId:supplierProactiveRefundApplicationNumber(actor().id,parsed.intent.operation_id),authorizeApplication:async()=>{}},0);
  const [refund]=await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,created.refundId));
  if(!refund)throw Error('Actual refund application absent');return {order,carts,source,parsed,refund};
 }
 async function settle(tx:DbClient,id:number,options:{omitOperation?:boolean;wrongOutcome?:boolean;corruptSourceField?:'payTime'|'payType'}={}){
  const {order,source,parsed,refund}=await application(tx,id);
  if(!options.omitOperation) {
   const operationSource=options.corruptSourceField?{...source,order:{...source.order,
    ...(options.corruptSourceField==='payTime'?{payTime:source.order.payTime+1}:{payType:'weixin'})}}:source;
   const intentJson=supplierProactiveRefundJson(parsed.intent),sourceJson=supplierProactiveRefundJson(operationSource);
   await tx.execute(sql`INSERT INTO public.supplier_proactive_refund_operation_v1
    (operation_id,actor_id,supplier_id,order_id,state,kind,request_hash,intent,intent_json,source,source_json,source_hash,result,created_at)
    VALUES(${parsed.intent.operation_id}::uuid,${actor().id},${actor().supplierId},${id},'committed','goods',${parsed.hash},
     ${intentJson}::jsonb,${intentJson},${sourceJson}::jsonb,${sourceJson},${await outRequestHash(operationSource)},
     ${JSON.stringify({refund_id:refund.id})}::jsonb,${Math.floor(Date.now()/1000)})`);
  }
  const [current]=await tx.select().from(storeOrder).where(eq(storeOrder.id,id));
  const cap=await prepareSupplierProactiveRefundApplication(tx,actor(),current,{phase:'execution',...parsed});
  const manualSource=await readSupplierManualRefundSource(tx,current,refund),request=await parseSupplierManualRefundIntent(refund.id,
   {operation_id:parsed.intent.operation_id,revision:supplierManualRefundMac(supplierOrderEditAppKey,manualSource,actor()),refund_price:'7.00',cash_returned:true},actor());
  const manual=await prepareSupplierProactiveManualRefundExecution(tx,cap,actor(),request.intent,request.hash,current,refund);
  const beforeEffects=await captureFinancialEffects(tx,current,refund);
  expect(await new StoreOrderRefundService(createContainerFromDb(tx),f.paymentEnvironment).agreeRefund(refund.id,
   {supplierProactiveRefundCapability:cap,supplierManualRefund:manual,expectedSupplierId:7,expectedStoreOrderId:id,
    expectedRefundAmountCents:700,requirePaid:true})).toMatchObject({completed:true});
  const evidence={refund_id:refund.id},text=supplierProactiveRefundJson(evidence);
  await tx.execute(sql`INSERT INTO public.supplier_proactive_refund_decision_v1
   (operation_id,actor_id,supplier_id,order_id,kind,outcome,request_hash,evidence,evidence_json,evidence_hash,created_at)
   VALUES(${parsed.intent.operation_id}::uuid,${actor().id},${actor().supplierId},${id},'goods',${options.wrongOutcome?'provider-admitted':'local-settled'},${parsed.hash},
    ${text}::jsonb,${text},${await outRequestHash(evidence)},${Math.floor(Date.now()/1000)})`);
  await verifyFinancialLocalRefund(tx,beforeEffects,readBoundManualRefundProof);
  const [completed]=await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,refund.id));
  await verifyFinancialMaterializedRefund(tx,completed,new Set(),readBoundManualRefundProof);
  return {refund:completed,order,operationId:parsed.intent.operation_id};
 }

 it('cancels the complete actual18.75 unissued original once for a7.00 first refund and retains11.75 as money only',async()=>{
  const {id,invoice}=await paidInvoice();
  await commissioned(async runtime=>{
   const account=(await runtime.db.select().from(user).where(eq(user.uid,11)))[0];
   const settled=await withTx(runtime.container,tx=>settle(tx,id)),record=await runtime.receipt(settled.refund.id);
   expect(record).toMatchObject({disposition:'whole',sourceOrderId:id,selectedOrderId:id,remainingOrderId:null});
   const allocation=JSON.parse(record!.invoiceAllocation);
   expect(allocation).toMatchObject({version:SUPPLIER_WHOLE_INVOICE_VERSION,operation_id:settled.operationId,refundId:settled.refund.id,
    original:invoice,selected:{invoiceId:invoice.id,orderId:id,amount:'18.75'},remaining:null,goods_quantity:3,first_refunded:'7.00',unreturned_payment:'11.75',manual_disposition:null});
   expect(await f.db.select().from(storeOrderInvoice)).toEqual([{...invoice,isRefund:1}]);
   expect(await runtime.order(id)).toMatchObject({paid:1,payPrice:'18.75',refundPrice:'7.00',refundStatus:2});
   expect((await runtime.db.select().from(user).where(eq(user.uid,11)))[0].nowMoney).toBe(account.nowMoney);
   const before=await snapshot();
   await withTx(runtime.container,async tx=>{
    await assertStoredSupplierProactiveInvoiceAllocation(tx,record!.invoiceAllocation,11,id);
    await assertStoredManualInvoiceAllocation(tx,record!.invoiceAllocation,11,id);
    await verifyFinancialMaterializedRefund(tx,settled.refund,new Set(),readBoundManualRefundProof);
   });
   expect(await snapshot()).toEqual(before);
   for(const changed of [{...allocation,source_hash:'f'.repeat(64)},{...allocation,refundId:settled.refund.id+1},
    {...allocation,original:{...invoice,remark:'forged original'}},{...allocation,manual_disposition:{version:'invoice-manual-disposition-v1'}}]) {
    await withTx(runtime.container,tx=>expect(assertStoredSupplierProactiveInvoiceAllocation(tx,supplierProactiveRefundJson(changed),11,id)).rejects.toThrow());
   }
   expect(await snapshot()).toEqual(before);
  });expect(fetch).not.toHaveBeenCalled();
 },120000);
 it('keeps mature no-cap invoice concessions rejected and rejects serialized or cross-transaction prepared authority',async()=>{
  const {id,invoice}=await paidInvoice();await commissioned(async runtime=>{
   const before=await snapshot();
   await expect(withTx(runtime.container,async tx=>prepareRefundInvoice(tx,(await tx.select().from(storeOrder).where(eq(storeOrder.id,id)))[0],'18.75','7.00'))).rejects.toThrow('少退');
   let saved:Awaited<ReturnType<typeof prepareRefundInvoice>>=null;
   const created=await withTx(runtime.container,async tx=>{
    const result=await application(tx,id),[order]=await tx.select().from(storeOrder).where(eq(storeOrder.id,id));
    const cap=await prepareSupplierProactiveRefundApplication(tx,actor(),order,{phase:'execution',...result.parsed});
    saved=await prepareRefundInvoice(tx,order,'18.75','7.00',cap);
    await expect(materializeRefundInvoice(tx,order,result.refund,{...invoice},id,null)).rejects.toThrow();return result;
   });
   const held=await snapshot();
   await expect(withTx(runtime.container,async tx=>materializeRefundInvoice(tx,(await tx.select().from(storeOrder).where(eq(storeOrder.id,id)))[0],created.refund,saved,id,null))).rejects.toThrow('原票');
   expect(await snapshot()).toEqual(held);expect(held.invoices).toEqual(before.invoices);
  });
 },120000);
 it('rejects an actual provider decision on a local cash refund and rolls back the complete transaction',async()=>{
  const {id}=await paidInvoice();await commissioned(async runtime=>{
   const before=await snapshot();await expect(withTx(runtime.container,tx=>settle(tx,id,{wrongOutcome:true}))).rejects.toThrow();
   expect(await snapshot()).toEqual(before);
  });
 },120000);
 it('rolls the actual refund, point, stock and invoice writes back when immutable original operation evidence is absent',async()=>{
  const {id}=await paidInvoice();await commissioned(async runtime=>{
   const before=await snapshot();await expect(withTx(runtime.container,tx=>settle(tx,id,{omitOperation:true}))).rejects.toThrow('原票');
   expect(await snapshot()).toEqual(before);
  });
 },120000);
 it('rejects a late actual invoice row change and rolls back all real financial and physical effects',async()=>{
  const {id}=await paidInvoice();await commissioned(async runtime=>{
   await f.exec(`CREATE FUNCTION public.owned_proactive_invoice_late() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
     IF NEW.is_refund=1 AND OLD.is_refund=0 THEN NEW.remark:=NEW.remark||' unexpected late rewrite'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER owned_proactive_invoice_late BEFORE UPDATE ON public.store_order_invoice FOR EACH ROW EXECUTE FUNCTION public.owned_proactive_invoice_late()`);
   try {const before=await snapshot();await expect(withTx(runtime.container,tx=>settle(tx,id))).rejects.toThrow('原票');expect(await snapshot()).toEqual(before);}
   finally {await f.exec('DROP TRIGGER owned_proactive_invoice_late ON public.store_order_invoice;DROP FUNCTION public.owned_proactive_invoice_late()');}
  });
 },120000);
 it.each(['payTime','payType'] as const)('rejects a canonical immutable operation with a wrong original %s and rolls every real write back',async field=>{
  const {id}=await paidInvoice();await commissioned(async runtime=>{
   const before=await snapshot();
   await expect(withTx(runtime.container,tx=>settle(tx,id,{corruptSourceField:field}))).rejects.toThrow('原票');
   expect(await snapshot()).toEqual(before);
  });
 },120000);

});
