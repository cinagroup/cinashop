import {supplierProactiveRefundApplicationNumber} from '@/services/supplier/SupplierProactiveRefundIdentity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createContainerFromDb, withTx } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, systemRole, user } from '@/models/schema';
import { installSupplierProactiveRefund } from '@/migrations/supplierProactiveRefund';
import { applyOrderRefundWithMaterialization, quoteOrderRefundWithMaterialization, StoreOrderRefundService } from '@/services/order/StoreOrderRefundService';
import { StoreOrderPayService } from '@/services/order/StoreOrderPayService';
import { prepareSupplierProactiveRefundApplication, authorizeSupplierProactiveRefundApplication } from '@/services/supplier/SupplierProactiveRefundCapability';
import { prepareSupplierProactiveManualRefundExecution, readSupplierManualRefundSource, readBoundManualRefundProof } from '@/services/supplier/SupplierManualRefundProof';
import { parseSupplierProactiveRefundIntent } from '@/services/supplier/SupplierProactiveRefundInput';
import { parseSupplierManualRefundIntent, supplierManualRefundMac } from '@/services/supplier/SupplierManualRefundInput';
import { captureFinancialEffects, verifyFinancialLocalRefund } from '@/services/customer-work/CustomerWorkFinancialVerification';
import { supplierManualRefundFixture } from './helpers/supplierManualRefund';
import { supplierOrderEditActor, supplierOrderEditAppKey } from './helpers/supplierUnpaidOrderEdit';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual Supplier order.manage whole-goods refund capabilities',()=>{
  let f:Awaited<ReturnType<typeof supplierManualRefundFixture>>;
  beforeEach(async()=>{
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No real provider traffic in owned capability acceptance'));
    f=await supplierManualRefundFixture();
  },120000);
  afterEach(async()=>{try{await f?.close();}finally{vi.restoreAllMocks();}},30000);
  const actor=()=>supplierOrderEditActor();
  async function paid(channel:'offline'|'yue'|'weixin'|'alipay'='offline') {
    const order=await f.createOffline();
    await f.service.save(order.id,{...await f.body(order.id),pay_price:'18.75',gain_integral:'17'},actor());
    if(channel==='offline')await f.withPaymentRuntime(async(_runtime,payment)=>payment.pay(order.id,await f.paymentBody(order.id,payment),actor()));
    else await f.withPaidConsumer(async(runtime)=>{
      const service=new StoreOrderPayService(runtime.container,f.paymentEnvironment);
      if(channel==='yue')expect(await service.yuePay(11,order.orderId)).toEqual({paid:true});
      else expect(await service.applyPayment({orderId:order.id,payType:channel,tradeNo:'owned-provider-trade-'+order.id})).toMatchObject({outcome:'paid'});
    });
    await f.consumePaid(order.id);return order.id;
  }
  async function commissioned<T>(work:(runtime:Parameters<Parameters<typeof f.withManualRuntime>[0]>[0])=>Promise<T>) {
    return f.withManualRuntime(async runtime=>{
      await f.db.transaction(tx=>installSupplierProactiveRefund(tx,{runtimeRole:runtime.role}));
      // Deliberately remove refund.manage: this is the PHP order action's real
      // order.manage principal, never Customer/Admin or a refund reviewer.
      await f.db.update(systemRole).set({rules:'supplier.order.manage'}).where(eq(systemRole.id,21));
      return work(runtime);
    });
  }
  it.each(['offline','yue','weixin','alipay'] as const)('quotes/creates a whole-goods7.00 application from actual %s payment with only order.manage',async channel=>{
    const id=await paid(channel);
    await commissioned(async runtime=>{
      const order=await runtime.order(id),carts=await runtime.carts(id),selections=carts.map(row=>({cartId:row.id,cartNum:row.cartNum}));
      await withTx(runtime.container,async tx=>{
        const quoteCap=await prepareSupplierProactiveRefundApplication(tx,actor(),order,{phase:'quote'});
        const before=await f.manualSnapshot();
        const quote=await quoteOrderRefundWithMaterialization(createContainerFromDb(tx),{uid:order.uid,orderId:order.orderId,
          privilegedActor:'supplier',selectorNamespace:'row',applyType:4,supplierProactiveRefundCapability:quoteCap,cartSelections:selections,
          authorizeApplication:async()=>{}},0);
        expect(quote).toMatchObject({quotedPrice:'18.75',refundNum:3,receivedAt:null});
        expect(await f.manualSnapshot()).toEqual(before);
        const parsed=await parseSupplierProactiveRefundIntent(id,{operation_id:randomUUID(),revision:'a'.repeat(64),refund_price:'7.00',
          ...(channel==='offline'?{cash_returned:true}:{})},actor());
        const cap=await prepareSupplierProactiveRefundApplication(tx,actor(),order,{phase:'application',...parsed});
        const created=await applyOrderRefundWithMaterialization(createContainerFromDb(tx),{uid:order.uid,orderId:order.orderId,
          privilegedActor:'supplier',selectorNamespace:'row',applyType:4,supplierProactiveRefundCapability:cap,cartSelections:selections,
          refundReason:'实际整单商品少额首退款',refundExplain:'',requestedRefundAmountCents:700,expectedRefundAmountCents:1875,
          applicationOrderId:supplierProactiveRefundApplicationNumber(actor().id,parsed.intent.operation_id),authorizeApplication:async()=>{}},0);
        const [refund]=await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,created.refundId));
        expect(refund).toMatchObject({supplierId:7,uid:11,refundNum:3,refundPrice:'7.00',refundedPrice:'0.00',refundType:0});
        if(channel==='weixin'||channel==='alipay')return;
        const current=(await tx.select().from(storeOrder).where(eq(storeOrder.id,id)))[0];
        const executionCap=await prepareSupplierProactiveRefundApplication(tx,actor(),current,{phase:'execution',...parsed});
        let manual;
        if(channel==='offline') {
          const source=await readSupplierManualRefundSource(tx,current,refund);
          const request=await parseSupplierManualRefundIntent(refund.id,{operation_id:parsed.intent.operation_id,
            revision:supplierManualRefundMac(supplierOrderEditAppKey,source,actor()),refund_price:'7.00',cash_returned:true},actor());
          manual=await prepareSupplierProactiveManualRefundExecution(tx,executionCap,actor(),request.intent,request.hash,current,refund);
        }
        const account=(await tx.select().from(user).where(eq(user.uid,11)))[0],beforeEffects=await captureFinancialEffects(tx,current,refund);
        expect(await new StoreOrderRefundService(createContainerFromDb(tx),f.paymentEnvironment).agreeRefund(refund.id,{
          supplierProactiveRefundCapability:executionCap,supplierManualRefund:manual,expectedSupplierId:7,expectedStoreOrderId:id,
          expectedRefundAmountCents:700,requirePaid:true})).toMatchObject({completed:true});
        await verifyFinancialLocalRefund(tx,beforeEffects,readBoundManualRefundProof);
        const settled=(await tx.select().from(storeOrder).where(eq(storeOrder.id,id)))[0],after=(await tx.select().from(user).where(eq(user.uid,11)))[0];
        expect(settled).toMatchObject({payPrice:'18.75',refundPrice:'7.00',refundStatus:2});
        expect(Number(after.nowMoney)-Number(account.nowMoney)).toBe(channel==='offline'?0:7);
      });
    });
    expect(fetch).not.toHaveBeenCalled();
  },120000);

  it('rejects autocommit, JSON forgery, cross-transaction and changed source while accepting a genuine nested savepoint',async()=>{
    const id=await paid();
    await commissioned(async runtime=>{
      const order=await runtime.order(id),carts=await runtime.carts(id);
      await expect(prepareSupplierProactiveRefundApplication(runtime.db,actor(),order,{phase:'quote'})).rejects.toThrow('主动退款');
      let saved:Awaited<ReturnType<typeof prepareSupplierProactiveRefundApplication>>;
      await withTx(runtime.container,async tx=>{
        saved=await prepareSupplierProactiveRefundApplication(tx,actor(),order,{phase:'quote'});
        await expect(authorizeSupplierProactiveRefundApplication(tx,{} as never,order,carts)).rejects.toThrow();
        await withTx(createContainerFromDb(tx),async nested=>expect((await authorizeSupplierProactiveRefundApplication(nested,saved,order,carts)).phase).toBe('quote'));
        await tx.update(storeOrderCartInfo).set({isSupportRefund:0}).where(eq(storeOrderCartInfo.id,carts[0].id));
        await expect(authorizeSupplierProactiveRefundApplication(tx,saved,order,await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,id)))).rejects.toThrow();
      });
      await withTx(runtime.container,tx=>expect(authorizeSupplierProactiveRefundApplication(tx,saved!,order,carts)).rejects.toThrow());
    });
  },120000);

  it('rejects positive cash without returned confirmation before any refund application',async()=>{
    const id=await paid();
    await commissioned(async runtime=>{
      const before=await f.manualSnapshot();
      await expect(withTx(runtime.container,async tx=>{
        const order=(await tx.select().from(storeOrder).where(eq(storeOrder.id,id)))[0];
        const carts=await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,id));
        const parsed=await parseSupplierProactiveRefundIntent(id,{operation_id:randomUUID(),revision:'a'.repeat(64),refund_price:'7.00'},actor());
        const application=await prepareSupplierProactiveRefundApplication(tx,actor(),order,{phase:'application',...parsed});
        const created=await applyOrderRefundWithMaterialization(createContainerFromDb(tx),{uid:order.uid,orderId:order.orderId,
          privilegedActor:'supplier',selectorNamespace:'row',applyType:4,supplierProactiveRefundCapability:application,
          cartSelections:carts.map(row=>({cartId:row.id,cartNum:row.cartNum})),requestedRefundAmountCents:700,expectedRefundAmountCents:1875,
          refundReason:'必须真实返还现金',refundExplain:'',applicationOrderId:supplierProactiveRefundApplicationNumber(actor().id,parsed.intent.operation_id),authorizeApplication:async()=>{}},0);
        const current=(await tx.select().from(storeOrder).where(eq(storeOrder.id,id)))[0];
        const refund=(await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,created.refundId)))[0];
        const execution=await prepareSupplierProactiveRefundApplication(tx,actor(),current,{phase:'execution',...parsed});
        const source=await readSupplierManualRefundSource(tx,current,refund);
        const manual=await parseSupplierManualRefundIntent(refund.id,{operation_id:parsed.intent.operation_id,
          revision:supplierManualRefundMac(supplierOrderEditAppKey,source,actor()),refund_price:'7.00'},actor());
        await prepareSupplierProactiveManualRefundExecution(tx,execution,actor(),manual.intent,manual.hash,current,refund);
      })).rejects.toThrow(/现金已(?:实际)?返还/);
      expect(await f.manualSnapshot()).toEqual(before);
    });
  },120000);

  it('rejects a cash confirmation on actual balance payment before any application or money effects',async()=>{
    const id=await paid('yue');
    await commissioned(async runtime=>{
      const before=await f.manualSnapshot();
      await expect(withTx(runtime.container,async tx=>{
        const order=(await tx.select().from(storeOrder).where(eq(storeOrder.id,id)))[0];
        const parsed=await parseSupplierProactiveRefundIntent(id,{operation_id:randomUUID(),revision:'a'.repeat(64),refund_price:'7.00',cash_returned:true},actor());
        await prepareSupplierProactiveRefundApplication(tx,actor(),order,{phase:'application',...parsed});
      })).rejects.toThrow('须省略现金返还确认');
      expect(await f.manualSnapshot()).toEqual(before);
    });
  },120000);
});
