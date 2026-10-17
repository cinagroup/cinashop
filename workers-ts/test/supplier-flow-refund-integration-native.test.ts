/** Actual paid goods7 + money5 followed by the public descriptive note write.
 * Supplier identity, original UUID receipts and both independent read realms
 * retain their own authority. No financial success input is manufactured. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {createApp} from '@/app';
import type {Container} from '@/lib/di';
import {storeOrder,storeOrderRefund,supplierFlowingWater,systemRole} from '@/models/schema';
import {createToken,md5} from '@/utils/jwt';
import {supplierRefundSettlementReadFixture,settlementReadPassword} from './helpers/supplierRefundSettlementRead';
import {supplierOrderEditActor,supplierOrderEditPassword} from './helpers/supplierUnpaidOrderEdit';
const wiring=vi.hoisted(()=>({ordinary:undefined as Container|undefined,admin:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),
 createContainer:()=>{if(!wiring.ordinary)throw Error('Owned ledger integration LOGIN absent');return wiring.ordinary;},
 createAdminDatabaseSession:()=>{if(!wiring.admin)throw Error('Owned Admin ledger reader absent');return{container:wiring.admin,close:async()=>{}};},
}));
const app=createApp();
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier ledger note actual financial-chain compatibility',()=>{
 let f:Awaited<ReturnType<typeof supplierRefundSettlementReadFixture>>;
 beforeEach(async()=>{vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Owned ledger integration forbids outbound'));
  f=await supplierRefundSettlementReadFixture();wiring.ordinary=f.container;
  await f.db.update(systemRole).set({rules:'supplier.order.manage,supplier.refund.manage,supplier.finance.manage'}).where(eq(systemRole.id,21));
 },120000);
 afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();await f?.close();}finally{wiring.ordinary=undefined;wiring.admin=undefined;vi.restoreAllMocks();}},45000);
 async function http(path:string,realm:'supplier'|'api'|'admin'='supplier',body?:unknown) {
  const token=await createToken(realm==='supplier'?21:101,realm,md5(realm==='supplier'?supplierOrderEditPassword:settlementReadPassword),f.paymentEnvironment.APP_KEY);
  const response=await app.request(path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token.token,
   ...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})},f.paymentEnvironment);
  return{response,body:await response.json<{status:number;data:any}>()};
 }
 it('keeps goods7 money5 public mark compatible with original receipts settlement and tail6.75',async()=>{
  const id=await f.paid();
  await f.withWriter(async(_runtime,service)=>{
   const first=await f.execute(service,id,'7.00'),second=await f.execute(service,id,'5.00');
   const rows=await f.db.select().from(supplierFlowingWater).orderBy(supplierFlowingWater.id);expect(rows).toHaveLength(2);
   await f.withReader(async(note)=>{
    await f.exec(`GRANT UPDATE(id) ON public.system_admin,public.system_supplier,public.system_role,public.system_menus TO "${note.role}"; GRANT UPDATE(mark) ON public.supplier_flowing_water TO "${note.role}"`);
    wiring.ordinary=note.container;
    const before=await f.snapshot();
    for(const row of rows){
     const read=await http(`/supplierapi/finance/supplier_flowing_water/mark/${row.id}?selection=ledger`);expect(read.body.status).toBe(200);
     const result=await http(`/supplierapi/finance/supplier_flowing_water/mark/${row.id}`,'supplier',{selection:'ledger',mark:'首退后核对资金'+row.id,expected_revision:read.body.data.revision});
     expect(result.body).toMatchObject({status:200,data:{id:row.id,mark:'首退后核对资金'+row.id}});
    }
    const after=await f.snapshot();
    for(const key of Object.keys(before).filter(key=>key!=='supplier_flowing_water'))expect((after as Record<string,unknown>)[key]).toEqual((before as Record<string,unknown>)[key]);
    expect(await f.db.select().from(supplierFlowingWater).orderBy(supplierFlowingWater.id)).toEqual(rows.map(row=>({...row,mark:'首退后核对资金'+row.id})));

   });
   // Before the compatibility fix this actual public note makes the first
   // frozen supplierLedger full-row equality fail with409 at this seed.
   const seed=await service.seed(id,supplierOrderEditActor());expect(seed).toMatchObject({title:'补退货款',refund_price:'6.75'});
   const before=await f.snapshot();expect(await service.execute(id,first.body,supplierOrderEditActor())).toEqual(first.result);
   expect(await service.execute(id,second.body,supplierOrderEditActor())).toEqual(second.result);expect(await f.snapshot()).toEqual(before);
   await f.withReader(async(customer,grantCustomer)=>f.withReader(async(admin,grantAdmin)=>{
    await grantCustomer();await grantAdmin();wiring.ordinary=customer.container;wiring.admin=admin.container;
    const[order]=await f.db.select().from(storeOrder).where(eq(storeOrder.id,id)),[refund]=await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId,id));
    const snapshot=await f.snapshot();
    expect((await http(`/api/mobile/work/financial/orders/${id}/supplier-refund-settlement?order_no=${order.orderId}`,'api')).body).toMatchObject({status:200,data:{data:{refunded:'12.00',available:'6.75'}}});
    expect((await http(`/adminapi/refund/settlement/${refund.id}`,'admin')).body).toMatchObject({status:200,data:{refunded:'12.00',available:'6.75'}});
    expect(await f.snapshot()).toEqual(snapshot);
   }));
   const tailBefore=await f.snapshot(),tail=await f.execute(service,id,'6.75');expect(tail.result).toMatchObject({state:'committed',result:{amount:'6.75'}});
   const seedAfter=await f.db.select().from(storeOrder).where(eq(storeOrder.id,id));expect(seedAfter[0].refundPrice).toBe('18.75');
   expect((await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId,id)))[0].refundPrice).toBe('7.00');
   expect(await f.db.select().from(supplierFlowingWater)).toHaveLength(2);
   const tailAfter=await f.snapshot();for(const key of ['supplier_flowing_water','store_order_refund','store_order_cart_info','store_product','store_product_attr_value','manual_proofs','invoices']){expect(key in tailBefore&&key in tailAfter).toBe(true);expect((tailAfter as Record<string,unknown>)[key]).toEqual((tailBefore as Record<string,unknown>)[key]);}
  });
 },120000);
 it('keeps every nonmark first-ledger field and exact row set protected after a legitimate note',async()=>{
  const id=await f.paid('yue');await f.withWriter(async(_runtime,service)=>{
   await f.execute(service,id,'7.00');const second=await f.execute(service,id,'5.00'),rows=await f.db.select().from(supplierFlowingWater).orderBy(supplierFlowingWater.id);
   expect(rows).toHaveLength(2);
   await f.withReader(async note=>{
    await f.exec(`GRANT UPDATE(id) ON public.system_admin,public.system_supplier,public.system_role,public.system_menus TO "${note.role}"; GRANT UPDATE(mark) ON public.supplier_flowing_water TO "${note.role}"`);wiring.ordinary=note.container;
    expect((await http(`/supplierapi/finance/supplier_flowing_water/mark/${rows[1].id}`,'supplier',{mark:'合法旧POST描述'})).body).toMatchObject({status:200,data:null});
   });
   const original=(await f.db.select().from(supplierFlowingWater).where(eq(supplierFlowingWater.id,rows[1].id)))[0];
   const faults=[{number:'0.01'},{supplierId:8},{uid:12},{orderId:'OTHER-FINANCIAL-ID'},{linkId:'OTHER-LINK'},
    {pm:1},{type:1},{status:0},{addTime:original.addTime+1},{tradeTime:original.tradeTime+1},{finishTime:original.finishTime+1},{isDel:1}];
   for(const fault of faults){
    await f.db.update(supplierFlowingWater).set(fault).where(eq(supplierFlowingWater.id,original.id));const before=await f.snapshot();
    try{await expect(service.seed(id,supplierOrderEditActor())).rejects.toMatchObject({httpStatus:409});
     await expect(service.receipt(second.body.operation_id,supplierOrderEditActor())).rejects.toMatchObject({httpStatus:409});expect(await f.snapshot()).toEqual(before);
    }finally{await f.db.update(supplierFlowingWater).set(original).where(eq(supplierFlowingWater.id,original.id));}
   }
   const[extra]=await f.db.insert(supplierFlowingWater).values({...original,id:undefined,orderId:'EXTRA-SAME-LINK'}).returning();
   try{await expect(service.seed(id,supplierOrderEditActor())).rejects.toMatchObject({httpStatus:409});}finally{await f.db.delete(supplierFlowingWater).where(eq(supplierFlowingWater.id,extra.id));}
   expect(await service.seed(id,supplierOrderEditActor())).toMatchObject({refund_price:'6.75'});
  });
 },120000);

});
