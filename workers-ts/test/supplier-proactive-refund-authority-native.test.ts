/** Real paid Supplier roots and independent runtime LOGIN. These are kernel
 * authority/source rejection tests, not acceptance of an order-ID HTTP route. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {createContainerFromDb,withTx,type DbClient} from '@/lib/di';
import {storeOrder,storeOrderCartInfo,systemRole} from '@/models/schema';
import {installSupplierProactiveRefund} from '@/migrations/supplierProactiveRefund';
import {applyOrderRefundWithMaterialization} from '@/services/order/StoreOrderRefundService';
import {prepareSupplierProactiveRefundApplication,authorizeSupplierProactiveRefundApplication} from '@/services/supplier/SupplierProactiveRefundCapability';
import {readSupplierProactiveRefundSource} from '@/services/supplier/SupplierProactiveRefundSource';
import {parseSupplierProactiveRefundIntent} from '@/services/supplier/SupplierProactiveRefundInput';
import {supplierProactiveRefundApplicationNumber} from '@/services/supplier/SupplierProactiveRefundIdentity';
import {supplierManualRefundFixture} from './helpers/supplierManualRefund';
import {supplierOrderEditActor} from './helpers/supplierUnpaidOrderEdit';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('real Supplier proactive refund authority and complete source fences',()=>{
 let f:Awaited<ReturnType<typeof supplierManualRefundFixture>>;
 type Runtime=Parameters<Parameters<typeof f.withManualRuntime>[0]>[0];
 const actor=()=>supplierOrderEditActor();
 beforeEach(async()=>{
  vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No provider traffic in owned Supplier authority acceptance'));
  f=await supplierManualRefundFixture();
 },120000);
 afterEach(async()=>{try{await f?.close();}finally{vi.restoreAllMocks();}},30000);
 async function commissioned<T>(work:(runtime:Runtime)=>Promise<T>){
  return f.withManualRuntime(async runtime=>{
   await f.db.transaction(tx=>installSupplierProactiveRefund(tx,{runtimeRole:runtime.role}));
   await f.db.update(systemRole).set({rules:'supplier.order.manage'}).where(eq(systemRole.id,21));return work(runtime);
  });
 }
 const state=async()=>({...await f.manualSnapshot(),roles:await f.db.select().from(systemRole).orderBy(systemRole.id),
  proactive:await f.exec('SELECT * FROM public.supplier_proactive_refund_operation_v1 ORDER BY operation_id'),
  decisions:await f.exec('SELECT * FROM public.supplier_proactive_refund_decision_v1 ORDER BY operation_id')});
 async function current(tx:DbClient,id:number){
  const [order]=await tx.select().from(storeOrder).where(eq(storeOrder.id,id));
  const carts=await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,id)).orderBy(storeOrderCartInfo.id);
  if(!order||!carts.length)throw Error('Actual paid Supplier source missing');return {order,carts};
 }
 it('rejects real view-only and foreign principals, moved tenant claims, expired logins and changed auth versions without writes',async()=>{
  const id=await f.paid();await commissioned(async runtime=>{
   const before=await state();
   const denied=[{principal:supplierOrderEditActor(22),message:'权限'},
    {principal:supplierOrderEditActor(31),message:'主动退款'},
    {principal:{...actor(),supplierId:8},message:'身份'},
    {principal:{...actor(),expiresAt:1},message:'过期'},
    {principal:{...actor(),authVersion:'0'.repeat(32)},message:'凭据'}];
   for(const {principal,message} of denied){
    await expect(withTx(runtime.container,async tx=>{
     const {order}=await current(tx,id);
     return prepareSupplierProactiveRefundApplication(tx,principal,order,{phase:'quote'});
    })).rejects.toThrow(message);
    expect(await state()).toEqual(before);
   }
  });expect(fetch).not.toHaveBeenCalled();
 },120000);
 it('rechecks actual order.manage after capability mint and rolls a revoked-role application back on the same connection',async()=>{
  const id=await f.paid();await commissioned(async runtime=>{
   const before=await state();
   await expect(withTx(runtime.container,async tx=>{
    const {order,carts}=await current(tx,id),parsed=await parseSupplierProactiveRefundIntent(id,{operation_id:randomUUID(),
     revision:'a'.repeat(64),refund_price:'7.00',cash_returned:true},actor());
    const cap=await prepareSupplierProactiveRefundApplication(tx,actor(),order,{phase:'application',...parsed});
    // The real authority table is already fenced. Deliberately mutate it on
    // this SAME SQL connection: a second max1-pool borrower would self-wait.
    await tx.update(systemRole).set({rules:'supplier.order.view'}).where(eq(systemRole.id,21));
    return applyOrderRefundWithMaterialization(createContainerFromDb(tx),{uid:order.uid,orderId:order.orderId,
     privilegedActor:'supplier',selectorNamespace:'row',applyType:4,supplierProactiveRefundCapability:cap,
     cartSelections:carts.map(row=>({cartId:row.id,cartNum:row.cartNum})),requestedRefundAmountCents:700,
     refundReason:'必须重新核对真实管理权限',refundExplain:'',applicationOrderId:supplierProactiveRefundApplicationNumber(actor().id,parsed.intent.operation_id),
     authorizeApplication:async()=>{}},0);
   })).rejects.toThrow('权限');
   expect(await state()).toEqual(before);
  });
 },120000);
 it('rejects actual post-mint source changes and oversized supplied SQL cart bytes without refund or operation writes',async()=>{
  const id=await f.paid();await commissioned(async runtime=>{
   const before=await state();
   await expect(withTx(runtime.container,async tx=>{
    const {order,carts}=await current(tx,id),cap=await prepareSupplierProactiveRefundApplication(tx,actor(),order,{phase:'quote'});
    await tx.update(storeOrderCartInfo).set({isSupportRefund:carts[0].isSupportRefund===1?0:1}).where(eq(storeOrderCartInfo.id,carts[0].id));
    const changed=await current(tx,id);
    return authorizeSupplierProactiveRefundApplication(tx,cap,changed.order,changed.carts);
   })).rejects.toMatchObject({httpStatus:409});
   expect(await state()).toEqual(before);
   const [original]=await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,id)).orderBy(storeOrderCartInfo.id);
   if(!original||!original.cartInfo)throw Error('Actual purchased snapshot absent');
   // This is a real oversized SQL source, not an HTTP flag or a truncated
   // pseudo-row. The bound also applies when the caller supplies locked carts.
   const oversized=JSON.stringify({...JSON.parse(original.cartInfo),owned_oversized_source:'x'.repeat(65536)});
   await f.db.update(storeOrderCartInfo).set({cartInfo:oversized}).where(eq(storeOrderCartInfo.id,original.id));
   try{
    const corrupt=await state();
    await expect(withTx(runtime.container,async tx=>{const {order,carts}=await current(tx,id);
     return readSupplierProactiveRefundSource(tx,order,carts);
    })).rejects.toMatchObject({httpStatus:409});
    await expect(withTx(runtime.container,async tx=>{const {order}=await current(tx,id);
     return prepareSupplierProactiveRefundApplication(tx,actor(),order,{phase:'quote'});
    })).rejects.toMatchObject({httpStatus:409});
    expect(await state()).toEqual(corrupt);
   }finally{await f.db.update(storeOrderCartInfo).set({cartInfo:original.cartInfo}).where(eq(storeOrderCartInfo.id,original.id));}
   expect(await state()).toEqual(before);
  });
 },120000);
 it('rejects genuine cross-transaction and JSON capabilities on an otherwise exact original application replay',async()=>{
  const id=await f.paid();await commissioned(async runtime=>{
   const first=await withTx(runtime.container,async tx=>{
    const {order,carts}=await current(tx,id),parsed=await parseSupplierProactiveRefundIntent(id,{operation_id:randomUUID(),
     revision:'a'.repeat(64),refund_price:'7.00',cash_returned:true},actor());
    const cap=await prepareSupplierProactiveRefundApplication(tx,actor(),order,{phase:'application',...parsed});
    // No requireNewApplication/expectedRefundAmountCents rejection may mask the
    // missing capability check in the mature idempotent-return branch.
    const input={uid:order.uid,orderId:order.orderId,privilegedActor:'supplier' as const,selectorNamespace:'row' as const,
     applyType:4 as const,supplierProactiveRefundCapability:cap,cartSelections:carts.map(row=>({cartId:row.id,cartNum:row.cartNum})),
     requestedRefundAmountCents:700,refundReason:'原操作同参数重放仍须真实能力',refundExplain:'',
     applicationOrderId:supplierProactiveRefundApplicationNumber(actor().id,parsed.intent.operation_id),authorizeApplication:async()=>{}};
    const created=await applyOrderRefundWithMaterialization(createContainerFromDb(tx),input,0);
    expect(created.refundId).toBeGreaterThan(0);return {input,created};
   });
   const committed=await state();
   for(const cap of [first.input.supplierProactiveRefundCapability,{} as never]){
    await expect(withTx(runtime.container,tx=>applyOrderRefundWithMaterialization(createContainerFromDb(tx),
     {...first.input,supplierProactiveRefundCapability:cap},0))).rejects.toMatchObject({httpStatus:409});
    expect(await state()).toEqual(committed);
   }
   expect((await runtime.carts(id)).every(row=>row.refundNum===row.cartNum)).toBe(true);
  });
 },120000);

});
