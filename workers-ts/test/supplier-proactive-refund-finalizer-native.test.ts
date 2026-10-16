/** Direct-finalizer acceptance under a genuine independent Supplier LOGIN.
 * Checkout, balance payment, paid effects and the whole-goods application use
 * actual services. No paid/refund state or account balance is manufactured. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {createContainerFromDb,withTx,type DbClient} from '@/lib/di';
import {storeOrder,storeOrderCartInfo,storeOrderRefund,systemRole,user} from '@/models/schema';
import {installSupplierProactiveRefund} from '@/migrations/supplierProactiveRefund';
import {applyOrderRefundWithMaterialization,finalizeStoreOrderRefund} from '@/services/order/StoreOrderRefundService';
import {StoreOrderPayService} from '@/services/order/StoreOrderPayService';
import {amountToCents} from '@/services/payment/RefundGateway';
import {captureFinancialEffects,verifyFinancialLocalRefund} from '@/services/customer-work/CustomerWorkFinancialVerification';
import {prepareSupplierProactiveRefundApplication} from '@/services/supplier/SupplierProactiveRefundCapability';
import {parseSupplierProactiveRefundIntent} from '@/services/supplier/SupplierProactiveRefundInput';
import {supplierProactiveRefundApplicationNumber} from '@/services/supplier/SupplierProactiveRefundIdentity';
import {supplierManualRefundFixture} from './helpers/supplierManualRefund';
import {supplierOrderEditActor} from './helpers/supplierUnpaidOrderEdit';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual Supplier proactive direct-finalizer admission',()=>{
 let f:Awaited<ReturnType<typeof supplierManualRefundFixture>>;
 type Runtime=Parameters<Parameters<typeof f.withManualRuntime>[0]>[0];
 const actor=()=>supplierOrderEditActor();
 beforeEach(async()=>{
  vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No provider traffic in owned direct-finalizer acceptance'));
  f=await supplierManualRefundFixture();
 },120000);
 afterEach(async()=>{try{await f?.close();}finally{vi.restoreAllMocks();}},30000);
 async function paid(){
  const order=await f.createOffline();
  await f.service.save(order.id,{...await f.body(order.id),pay_price:'18.75',gain_integral:'17'},actor());
  await f.withPaidConsumer(async runtime=>{
   expect(await new StoreOrderPayService(runtime.container,f.paymentEnvironment).yuePay(11,order.orderId)).toEqual({paid:true});
  });
  await f.consumePaid(order.id);return order.id;
 }
 async function commissioned<T>(work:(runtime:Runtime)=>Promise<T>){
  return f.withManualRuntime(async runtime=>{
   await f.db.transaction(tx=>installSupplierProactiveRefund(tx,{runtimeRole:runtime.role}));
   await f.db.update(systemRole).set({rules:'supplier.order.manage'}).where(eq(systemRole.id,21));
   return work(runtime);
  });
 }
 const snapshot=async()=>({...await f.manualSnapshot(),
  proactive:await f.exec('SELECT * FROM public.supplier_proactive_refund_operation_v1 ORDER BY operation_id'),
  decisions:await f.exec('SELECT * FROM public.supplier_proactive_refund_decision_v1 ORDER BY operation_id')});
 async function application(tx:DbClient,id:number){
  const [order]=await tx.select().from(storeOrder).where(eq(storeOrder.id,id));
  const carts=await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,id)).orderBy(storeOrderCartInfo.id);
  if(!order||!carts.length)throw Error('Actual paid Supplier source missing');
  const parsed=await parseSupplierProactiveRefundIntent(id,{operation_id:randomUUID(),revision:'a'.repeat(64),refund_price:'7.00'},actor());
  const cap=await prepareSupplierProactiveRefundApplication(tx,actor(),order,{phase:'application',...parsed});
  const created=await applyOrderRefundWithMaterialization(createContainerFromDb(tx),{uid:order.uid,orderId:order.orderId,
   privilegedActor:'supplier',selectorNamespace:'row',applyType:4,supplierProactiveRefundCapability:cap,
   cartSelections:carts.map(row=>({cartId:row.id,cartNum:row.cartNum})),requestedRefundAmountCents:700,expectedRefundAmountCents:1875,
   refundReason:'直接结算仍须原操作执行能力',refundExplain:'actual owned direct-finalizer acceptance',
   applicationOrderId:supplierProactiveRefundApplicationNumber(actor().id,parsed.intent.operation_id),authorizeApplication:async()=>{}},0);
  const [refund]=await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,created.refundId));
  const [current]=await tx.select().from(storeOrder).where(eq(storeOrder.id,id));
  if(!refund||!current)throw Error('Actual whole-goods refund application missing');
  expect(refund).toMatchObject({uid:11,supplierId:7,refundNum:3,refundPrice:'7.00',refundedPrice:'0.00',refundType:0});
  return {order:current,refund,parsed};
 }

 it.each(['quote','application','wrong-operation'] as const)('rejects a genuine %s capability at the direct finalizer and rolls the entire transaction back',async admission=>{
  const id=await paid();await commissioned(async runtime=>{
   const before=await snapshot();let finalizerEntered=false;
   await expect(withTx(runtime.container,async tx=>{
    const {order,refund,parsed}=await application(tx,id);
    const context=admission==='quote'?{phase:'quote' as const}:admission==='application'
     ?{phase:'application' as const,...parsed}
     :{phase:'execution' as const,...await parseSupplierProactiveRefundIntent(id,{operation_id:randomUUID(),
       revision:parsed.intent.revision,refund_price:'7.00'},actor())};
    // Mint from the ACTUAL current held source so phase/operation, rather than
    // an obsolete pre-application hash or connection mismatch, causes rejection.
    const cap=await prepareSupplierProactiveRefundApplication(tx,actor(),order,context);
    finalizerEntered=true;
    return finalizeStoreOrderRefund(createContainerFromDb(tx),refund.id,Math.floor(Date.now()/1000),{
     supplierProactiveRefundCapability:cap,expectedSupplierId:7,expectedStoreOrderId:id,
     expectedRefundAmountCents:700,requirePaid:true});
   })).rejects.toThrow();
   expect(finalizerEntered).toBe(true);
   expect(await snapshot()).toEqual(before);
  });expect(fetch).not.toHaveBeenCalled();
 },120000);

 it('settles a genuine original-operation execution capability directly and verifies actual balance, stock, points and materialization effects',async()=>{
  const id=await paid();await commissioned(async runtime=>{
   const refundId=await withTx(runtime.container,async tx=>{
    const {order,refund,parsed}=await application(tx,id);
    const cap=await prepareSupplierProactiveRefundApplication(tx,actor(),order,{phase:'execution',...parsed});
    const [account]=await tx.select().from(user).where(eq(user.uid,11));
    if(!account)throw Error('Actual paid buyer account missing');
    const beforeEffects=await captureFinancialEffects(tx,order,refund);
    expect(await finalizeStoreOrderRefund(createContainerFromDb(tx),refund.id,Math.floor(Date.now()/1000),{
     supplierProactiveRefundCapability:cap,expectedSupplierId:7,expectedStoreOrderId:id,
     expectedRefundAmountCents:700,requirePaid:true})).toBe('completed');
    await verifyFinancialLocalRefund(tx,beforeEffects);
    const [after]=await tx.select().from(user).where(eq(user.uid,11));
    const [settled]=await tx.select().from(storeOrder).where(eq(storeOrder.id,id));
    expect(amountToCents(after.nowMoney)).toBe(amountToCents(account.nowMoney)!+700);
    expect(settled).toMatchObject({paid:1,payType:'yue',payPrice:'18.75',refundPrice:'7.00',refundStatus:2,refundType:6});
    return refund.id;
   });
   const refund=(await runtime.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,refundId)))[0];
   expect(refund).toMatchObject({refundType:6,refundPrice:'7.00',refundedPrice:'7.00',refundNum:3});
   expect(await runtime.receipt(refundId)).toMatchObject({disposition:'whole',sourceOrderId:id,selectedOrderId:id,remainingOrderId:null});
  });expect(fetch).not.toHaveBeenCalled();
 },120000);
});
