/** Actual assembled App/JWT, real checkout/payment/refund effects and separate
 * authenticated PG16 reader LOGINs. No Supplier identity is borrowed for reads. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {createApp} from '@/app';
import {withTx,type Container} from '@/lib/di';
import {storeOrder,storeOrderInvoice,storeOrderRefund,storeService,systemAdmin,systemRole,userBill} from '@/models/schema';
import {createToken,md5} from '@/utils/jwt';
import {readVerifiedSupplierRefundSettlement} from '@/services/order/SupplierRefundSettlementReadService';
import {readBoundManualRefundProof} from '@/services/supplier/SupplierManualRefundProof';
import {verifyFinancialCompletedRefund} from '@/services/customer-work/CustomerWorkFinancialVerification';
import {SUPPLIER_REFUND_SETTLEMENT_READ_TABLES,assertSupplierRefundSettlementReadReady,
 supplierRefundSettlementReadReadiness,supplierRefundSettlementReadOnlyRole,runSupplierRefundSettlementRead} from '@/migrations/supplierRefundSettlementRead';
import {supplierOrderEditActor} from './helpers/supplierUnpaidOrderEdit';
import {supplierRefundSettlementReadFixture,settlementReadPassword} from './helpers/supplierRefundSettlementRead';

const wiring=vi.hoisted(()=>({ordinary:undefined as Container|undefined,admin:undefined as Container|undefined,adminOpens:0}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),
 createContainer:()=>{if(!wiring.ordinary)throw Error('Owned ordinary reader absent');return wiring.ordinary;},
 createAdminDatabaseSession:()=>{if(!wiring.admin)throw Error('Owned Admin reader absent');wiring.adminOpens++;
  return{container:wiring.admin,close:async()=>{}};},
}));
const app=createApp();
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Expected HTTP object');return value as Record<string,unknown>;}
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier settlement explicit authorized cross-realm reads',()=>{
 let f:Awaited<ReturnType<typeof supplierRefundSettlementReadFixture>>;
 beforeEach(async()=>{vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Owned settlement read forbids outbound I/O'));
  f=await supplierRefundSettlementReadFixture();wiring.ordinary=f.container;wiring.admin=undefined;wiring.adminOpens=0;
 },120000);
 afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();await f?.close();}
  finally{wiring.ordinary=undefined;wiring.admin=undefined;vi.restoreAllMocks();}},45000);
 async function http(path:string,realm:'api'|'admin'|'supplier'='api',id=101,extraHeaders:Record<string,string>={}) {
  const token=await createToken(id,realm,md5(settlementReadPassword),f.paymentEnvironment.APP_KEY);
  const response=await app.request(path,{headers:{Authorization:'Bearer '+token.token,...extraHeaders}},f.paymentEnvironment);
  return{response,body:object(await response.json())};
 }
 async function path(id:number){const [order]=await f.db.select().from(storeOrder).where(eq(storeOrder.id,id));
  if(!order)throw Error('Actual paid order absent');return `/api/mobile/work/financial/orders/${id}/supplier-refund-settlement?order_no=${encodeURIComponent(order.orderId)}`;}
 async function refund(id:number){const rows=await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId,id));
  expect(rows).toHaveLength(1);return rows[0];}
 async function readers<T>(work:()=>Promise<T>,commission=true){return f.withReader(async(customer,grantCustomer)=>
  f.withReader(async(admin,grantAdmin)=>{if(commission){await grantCustomer();await grantAdmin();}
   wiring.ordinary=customer.container;wiring.admin=admin.container;return work();}));}
 async function readBoth(id:number,expected:{refunded:string;money_refunded:string;available:string;money_payouts:number}){
  const before=await f.snapshot(),r=await refund(id),customer=await http(await path(id));
  expect(customer.body).toMatchObject({status:200,data:{actor_uid:101,principal:{kind:'customer-order-manager',scope:'global'},
   data:{version:'supplier-refund-settlement-v1',state:'verified',order_id:id,refund_id:r.id,uid:11,supplier_id:7,
    paid:'18.75',goods_refunded:'7.00',...expected}}});
  expect(customer.response.headers.get('cache-control')).toContain('private, no-store');
  const envelope=object(customer.body.data),summary=object(envelope.data);
  expect(Object.keys(summary).sort()).toEqual(['version','state','order_id','order_no','uid','supplier_id','store_id','refund_id',
   'refund_no','pay_type','paid','goods_refunded','money_refunded','refunded','available','money_payouts'].sort());
  expect(JSON.stringify(summary)).not.toContain('operation_id');expect(JSON.stringify(summary)).not.toContain('source_hash');
  for(const prefix of ['/adminapi','/api/admin']){
   const result=await http(`${prefix}/refund/settlement/${r.id}`,'admin');expect(result.body).toEqual({status:200,msg:expect.any(String),data:summary});
   expect(result.response.headers.get('cache-control')).toContain('private, no-store');
  }
  const scoped=await http(await path(id)+'&scope_key='+envelope.scope_key);expect(scoped.body).toEqual(customer.body);
  expect(await f.snapshot()).toEqual(before);return summary;
 }

 it.each(['offline','yue'] as const)('reads actual %s goods7 then money5 then tail6.75 on both independent SELECT-only realms',async channel=>{
  const id=await f.paid(channel),[invoice]=await f.db.insert(storeOrderInvoice).values({orderId:id,uid:11,category:'order',isPay:1,
   isRefund:0,isInvoice:0,invoiceAmount:'18.75',name:'真实完整原票',addTime:Math.floor(Date.now()/1000)}).returning();
  await f.withWriter(async(runtime,service)=>{
   const first=await f.execute(service,id,'7.00'),goodsSnapshot=await f.snapshot(),
    goodsPoints=(await f.db.select().from(userBill)).filter(row=>row.category==='integral');
   await readers(async()=>{
    await readBoth(id,{refunded:'7.00',money_refunded:'0.00',available:'11.75',money_payouts:0});
    const second=await f.execute(service,id,'5.00');await readBoth(id,{refunded:'12.00',money_refunded:'5.00',available:'6.75',money_payouts:1});
    // The two read subjects retain their own live permissions. Neither needs
    // the historical Supplier operation actor to retain management authority.
    await f.db.update(systemRole).set({rules:'supplier.order.view'}).where(eq(systemRole.id,21));
    try{await readBoth(id,{refunded:'12.00',money_refunded:'5.00',available:'6.75',money_payouts:1});}
    finally{await f.db.update(systemRole).set({rules:'supplier.order.manage,supplier.refund.manage'}).where(eq(systemRole.id,21));}
    const tail=await f.execute(service,id,'6.75');await readBoth(id,{refunded:'18.75',money_refunded:'11.75',available:'0.00',money_payouts:2});
    const before=await f.snapshot();
    expect(await service.execute(id,first.body,supplierOrderEditActor())).toEqual(first.result);
    expect(await service.execute(id,second.body,supplierOrderEditActor())).toEqual(second.result);
    expect(await service.execute(id,tail.body,supplierOrderEditActor())).toEqual(tail.result);
    expect(await f.snapshot()).toEqual(before);
    for(const key of ['store_order_refund','store_order_cart_info','store_product','store_product_attr_value','supplier_flowing_water','manual_proofs'] as const){
     expect(key in before&&key in goodsSnapshot).toBe(true);
     expect((before as Record<string,unknown>)[key]).toEqual((goodsSnapshot as Record<string,unknown>)[key]);
    }
    expect((await f.db.select().from(userBill)).filter(row=>row.category==='integral')).toEqual(goodsPoints);
    expect(await f.db.select().from(storeOrderInvoice)).toEqual([{...invoice,isRefund:1}]);
    const actualRefund=await refund(id);
    // The mature default remains strict; only the explicit composition projects
    // the protected first-goods monetary comparison in this read snapshot.
    await withTx(wiring.ordinary!,async tx=>{
     await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
     await expect(verifyFinancialCompletedRefund(tx,actualRefund,readBoundManualRefundProof)).rejects.toThrow();
    });
    expect(await runtime.order(id)).toMatchObject({refundPrice:'18.75'});
   });
  });
 },120000);

 it('preflights absent eight-table SELECT as503 without aborting the actual reader transaction',async()=>{
  const id=await f.paid();await f.withWriter(async(_runtime,service)=>{await f.execute(service,id,'7.00');
   await f.withReader(async(customer)=>f.withReader(async(admin)=>{
    wiring.ordinary=customer.container;wiring.admin=admin.container;
    for(const peer of [customer,admin])await peer.db.transaction(async tx=>{
     await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
     expect((await supplierRefundSettlementReadReadiness(tx)).ready).toBe(false);
     await expect(assertSupplierRefundSettlementReadReady(tx)).rejects.toMatchObject({httpStatus:503});
     const rows=await tx.execute<{still_live:number}>(sql`SELECT 42 AS still_live`);expect(rows[0].still_live).toBe(42);
    });
    const before=await f.snapshot();expect((await http(await path(id))).body.status).toBe(503);
    expect((await http('/adminapi/refund/settlement/'+(await refund(id)).id,'admin')).body.status).toBe(503);
    expect(await f.snapshot()).toEqual(before);
   }));
  });
 },120000);
 it.each(['offline','yue'] as const)('keeps both SELECT-only realms readable across real %s completed-goods refusals and payouts',async channel=>{
  const id=await f.paid(channel);await f.withWriter(async(runtime,service)=>{
   const first=await f.execute(service,id,'7.00');
   const refuse=async(amount:string)=>{const seed=await service.seed(id,supplierOrderEditActor());
    return service.execute(id,{operation_id:crypto.randomUUID(),revision:seed.revision,refund_price:amount,type:2},supplierOrderEditActor());};
   const refused=await refuse('5.00');
   expect(refused.result).toMatchObject({kind:'refuse',refund_id:null,status:'REFUSED'});
   await withTx(runtime.container,async tx=>{
    const r=await refund(id);
    await expect(verifyFinancialCompletedRefund(tx,r,readBoundManualRefundProof)).rejects.toMatchObject({code:400});
   });
   await readers(async()=>{
    await readBoth(id,{refunded:'7.00',money_refunded:'0.00',available:'11.75',money_payouts:0});
    await f.db.update(systemRole).set({rules:'supplier.order.view'}).where(eq(systemRole.id,21));
    try{await readBoth(id,{refunded:'7.00',money_refunded:'0.00',available:'11.75',money_payouts:0});}
    finally{await f.db.update(systemRole).set({rules:'supplier.order.manage,supplier.refund.manage'}).where(eq(systemRole.id,21));}
    await f.execute(service,id,'5.00');await refuse('3.00');
    await readBoth(id,{refunded:'12.00',money_refunded:'5.00',available:'6.75',money_payouts:1});
    await f.execute(service,id,'6.75');await readBoth(id,{refunded:'18.75',money_refunded:'11.75',available:'0.00',money_payouts:2});
    const stable=await f.snapshot();
    expect(await service.receipt(refused.operation_id,supplierOrderEditActor())).toEqual(refused);
    expect(await service.receipt(first.body.operation_id,supplierOrderEditActor())).toEqual(first.result);
    expect(await f.snapshot()).toEqual(stable);
   });
  });
 },120000);
 it('rejects unproved refused metadata on both realms despite an older valid anchor at a different amount',async()=>{
  const id=await f.paid();await f.withWriter(async(_runtime,service)=>{
   await f.execute(service,id,'7.00');const seed=await service.seed(id,supplierOrderEditActor());
   await service.execute(id,{operation_id:crypto.randomUUID(),revision:seed.revision,refund_price:'5.00',type:2},supplierOrderEditActor());
   await f.execute(service,id,'5.00');
   await f.db.update(storeOrder).set({refundStatus:0,refundType:3}).where(eq(storeOrder.id,id));
   await readers(async()=>{const before=await f.snapshot(),r=await refund(id);
    expect((await http(await path(id))).body.status).toBe(409);
    expect((await http('/adminapi/refund/settlement/'+r.id,'admin')).body.status).toBe(409);
    expect(await f.snapshot()).toEqual(before);
   });
  });
 },120000);
 it('commissions exactly eight SELECT privileges and no DML, owned sequence or Supplier write-function execution',async()=>{
  await f.withWriter(async()=>f.withReader(async(reader,commission)=>{
   expect((await supplierRefundSettlementReadOnlyRole(reader.db)).ready).toBe(false);await commission();
   expect((await supplierRefundSettlementReadOnlyRole(reader.db)).ready).toBe(true);
   expect((await supplierRefundSettlementReadReadiness(reader.db)).ready).toBe(true);
   const rows=await reader.db.execute<{name:string;read:boolean;write:boolean}>(sql`SELECT relname AS name,
    has_table_privilege(current_user,oid,'SELECT') AS read,
    has_table_privilege(current_user,oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS write
    FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN(${sql.join(SUPPLIER_REFUND_SETTLEMENT_READ_TABLES.map(name=>sql`${name}`),sql`,`)})`);
   expect(rows).toHaveLength(8);expect(rows.every(row=>row.read&&!row.write)).toBe(true);
   const [business]=await reader.db.execute<{tables:number;sequences:number;tables_read_only:boolean;sequences_read_only:boolean}>(sql`
    SELECT (SELECT count(*)::integer FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN('r','p')) AS tables,
     (SELECT count(*)::integer FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='S') AS sequences,
     NOT EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN('r','p') AND
      (has_table_privilege(current_user,oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_any_column_privilege(current_user,oid,'INSERT,UPDATE,REFERENCES'))) AS tables_read_only,
     NOT EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='S'
      AND has_sequence_privilege(current_user,oid,'USAGE,SELECT,UPDATE')) AS sequences_read_only`);
   expect(business.tables).toBeGreaterThan(8);expect(business.sequences).toBeGreaterThan(0);
   expect(business.tables_read_only).toBe(true);expect(business.sequences_read_only).toBe(true);
   const before=await f.snapshot();await commission();expect(await f.snapshot()).toEqual(before);
  }));
 },120000);
 it('allows an existing reviewed combined writer to use only the explicit READ ONLY composition',async()=>{
  const id=await f.paid();await f.withWriter(async(runtime,service)=>{await f.execute(service,id,'7.00');await f.execute(service,id,'5.00');
   expect((await supplierRefundSettlementReadOnlyRole(runtime.container.db)).ready).toBe(false);
   expect((await supplierRefundSettlementReadReadiness(runtime.container.db)).ready).toBe(true);
   await f.withReader(async(admin,commission)=>{await commission();wiring.admin=admin.container;wiring.ordinary=runtime.container;
    await readBoth(id,{refunded:'12.00',money_refunded:'5.00',available:'6.75',money_payouts:1});
   });
   await expect(runSupplierRefundSettlementRead(f.db,runtime.role)).rejects.toThrow('not read-only');
  });
 },120000);
 it.each(['missing-completion','missing-decision','wrong-first-refund','wrong-money-bill'] as const)(
  'fails closed on actual %s while every public GET remains write-free',async kind=>{
   const id=await f.paid(kind==='wrong-money-bill'?'yue':'offline');await f.withWriter(async(_runtime,service)=>{
    await f.execute(service,id,'7.00');const money=await f.execute(service,id,'5.00'),first=await refund(id);
    if(kind==='wrong-money-bill'){
     const bills=await f.db.select().from(userBill).where(eq(userBill.eventKey,'supplier_proactive_money_refund'));
     expect(bills).toHaveLength(1);await f.db.update(userBill).set({number:'4.99'}).where(eq(userBill.id,bills[0].id));
    }else if(kind==='wrong-first-refund')await f.db.update(storeOrderRefund).set({refundedPrice:'6.99'}).where(eq(storeOrderRefund.id,first.id));
    else {
     const table=kind==='missing-completion'?'supplier_refund_money_completion_v1':'supplier_proactive_refund_decision_v1';
     await f.db.transaction(async tx=>{await tx.execute(sql.raw(`ALTER TABLE public.${table} DISABLE TRIGGER USER`));
      await tx.execute(sql.raw(`DELETE FROM public.${table} WHERE operation_id='${money.body.operation_id}'`));
      await tx.execute(sql.raw(`ALTER TABLE public.${table} ENABLE TRIGGER USER`));});
    }
    await readers(async()=>{const before=await f.snapshot();
     expect((await http(await path(id))).body.status).toBe(409);
     expect((await http('/adminapi/refund/settlement/'+first.id,'admin')).body.status).toBe(409);
     expect(await f.snapshot()).toEqual(before);
    });
   });
  },120000);
 it('rechecks live Customer grant and rejects forged scope, query identity, token realm and path identity',async()=>{
  const id=await f.paid();await f.withWriter(async(_runtime,service)=>{await f.execute(service,id,'7.00');await readers(async()=>{
   const url=await path(id),before=await f.snapshot(),good=await http(url,'api',101,{'X-Supplier-Id':'8','X-User-Id':'102'});
   expect(good.body.status).toBe(200);expect(object(object(good.body.data).data).supplier_id).toBe(7);
   expect((await http(url+'&scope_key='+'0'.repeat(64))).body.status).toBe(403);
   for(const suffix of ['&uid=11','&supplier_id=7','&order_no=forged'])
    expect((await http(url+suffix)).body.status).not.toBe(200);
   expect((await http(url.replace('order_no=','order_no=forged'))).body.status).not.toBe(200);
   for(const realm of ['admin','supplier'] as const)expect((await http(url,realm)).body.status).not.toBe(200);
   expect((await http(url,'api',102,{'X-Customer-Uid':'101'})).body.status).not.toBe(200);
   expect(await f.snapshot()).toEqual(before);
   await f.db.update(storeService).set({customer:0}).where(eq(storeService.id,101));const withdrawn=await f.snapshot();
   expect((await http(url)).body.status).not.toBe(200);expect(await f.snapshot()).toEqual(withdrawn);
  });});
 },120000);
 it('requires live Admin refund.view before opening its independent read connection and forbids all query fields',async()=>{
  const id=await f.paid();await f.withWriter(async(_runtime,service)=>{await f.execute(service,id,'7.00');await readers(async()=>{
   const r=await refund(id),url='/adminapi/refund/settlement/'+r.id,before=await f.snapshot();
   const opens=wiring.adminOpens;
   for(const [realm,uid] of [['api',101],['supplier',101],['admin',102]] as const)
    expect((await http(url,realm,uid,{'X-Admin-Id':'101'})).body.status).not.toBe(200);
   expect(wiring.adminOpens).toBe(opens);
   expect((await http(url+'?scope_key=forged','admin')).body.status).not.toBe(200);
   expect((await http(url,'admin')).body.status).toBe(200);expect(await f.snapshot()).toEqual(before);
   await f.db.update(systemRole).set({rules:'order.view'}).where(eq(systemRole.id,101));const revokedOpens=wiring.adminOpens;
   expect((await http(url,'admin')).body.status).not.toBe(200);expect(wiring.adminOpens).toBe(revokedOpens);
   await f.db.update(systemAdmin).set({status:0}).where(eq(systemAdmin.id,101));
   expect((await http(url,'admin')).body.status).not.toBe(200);expect(wiring.adminOpens).toBe(revokedOpens);
  });});
 },120000);
 it('binds the optional refund ID to the actual first goods proof and does not accept a root or writable transaction',async()=>{
  const id=await f.paid();await f.withWriter(async(_runtime,service)=>{await f.execute(service,id,'7.00');
   const first=await refund(id);await f.withReader(async(reader,commission)=>{await commission();
    const [order]=await reader.db.select().from(storeOrder).where(eq(storeOrder.id,id));const before=await f.snapshot();
    await expect(readVerifiedSupplierRefundSettlement(reader.db,order)).rejects.toMatchObject({httpStatus:409});
    await withTx(reader.container,async tx=>{await expect(readVerifiedSupplierRefundSettlement(tx,order)).rejects.toMatchObject({httpStatus:409});});
    await withTx(reader.container,async tx=>{await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
     await expect(readVerifiedSupplierRefundSettlement(tx,order,first.id+1)).rejects.toMatchObject({httpStatus:409});
    });expect(await f.snapshot()).toEqual(before);
   });
  });
 },120000);
});
