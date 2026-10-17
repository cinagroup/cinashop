/** Owned native PG16 only. Business effects use checkout/payment/refund
 * services; maintenance creates authentication inputs and explicit read grants. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {createContainerFromDb,type Container} from '@/lib/di';
import {storeCart,storeOrder,storeOrderInvoice,storeService,systemAdmin,systemRole,user,capitalFlow} from '@/models/schema';
import {runtimeBusinessPrivilegePlan} from '@/migrations/runtimeBusinessPrivilegePlan';
import {customerManualRefundRuntimePrivilegePlan} from '@/migrations/customerManualRefundRuntimePlan';
import {installSupplierProactiveRefund} from '@/migrations/supplierProactiveRefund';
import {inspectCustomerWaybillActor,runCustomerWaybillActor} from '@/migrations/runCustomerWaybillActor';
import {runSupplierRefundSettlementRead} from '@/migrations/supplierRefundSettlementRead';
import {SupplierProactiveRefundService} from '@/services/supplier/SupplierProactiveRefundService';
import {StoreOrderPayService} from '@/services/order/StoreOrderPayService';
import {StoreOrderCreateService} from '@/services/order/StoreOrderCreateService';
import {supplierManualRefundFixture} from './supplierManualRefund';
import {supplierOrderEditActor,supplierOrderEditAppKey} from './supplierUnpaidOrderEdit';

export const settlementReadPassword='owned-settlement-reader-password';
export async function supplierRefundSettlementReadFixture() {
 const f=await supplierManualRefundFixture();
 try {
  // The actual full base migrations include legacy0091. Customer's existing
  // consistency reader needs its separately reviewed actor extension; install
  // that exact owner-only addon rather than manufacturing a compatible column.
  const waybill=await inspectCustomerWaybillActor(f.db);
  if(!waybill.legacy||waybill.ready)throw Error('Owned settlement fixture requires the exact legacy0091 waybill catalog');
  const upgraded=await runCustomerWaybillActor(f.db);
  console.log('SUPPLIER_SETTLEMENT_READ_WAYBILL_ACTOR '+JSON.stringify(upgraded));
  await f.db.insert(user).values([101,102].map(uid=>({uid,account:'owned-settlement-reader-'+uid,pwd:settlementReadPassword,status:1})));
  await f.db.insert(storeService).values([{id:101,uid:101,customer:1,accountStatus:1,status:0},
   {id:102,uid:102,customer:0,accountStatus:1,status:1}]);
  await f.db.insert(systemRole).values([{id:101,type:1,rules:'refund.view'},{id:102,type:1,rules:'order.view'}]);
  await f.db.insert(systemAdmin).values([101,102].map(id=>({id,account:'owned-settlement-admin-'+id,
   pwd:settlementReadPassword,adminType:1,roles:String(id),level:1,status:1})));
  const grantBusinessReads=async(role:string)=>{
   const allowed=new Set([...Object.keys(runtimeBusinessPrivilegePlan('app').tables),
    ...Object.keys(runtimeBusinessPrivilegePlan('admin').tables),...Object.keys(customerManualRefundRuntimePrivilegePlan().tables)]);
   const existing=await f.db.execute<{name:string}>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'`);
   for(const row of existing)if(allowed.has(row.name))await f.exec(`GRANT SELECT ON public."${row.name}" TO "${role}"`);
  };
  const paid=async(channel:'offline'|'yue'='offline',fresh=false)=>{
   const order=await(fresh?f.withPaymentRuntime(async runtime=>{
    const originals=await f.db.select().from(storeCart).where(sql`${storeCart.id} IN(1,2)`).orderBy(storeCart.id);
    if(originals.length!==2)throw Error('Actual owned purchase cart inputs absent');
    const rows=await f.db.insert(storeCart).values(originals.map(row=>({...row,id:row.id+1000,isPay:0,status:1}))).returning({id:storeCart.id});
    const result=await StoreOrderCreateService.createWithRuntime(runtime.container,
     {CONFIG_KV:f.env.CONFIG_KV,nextOrderId:async()=>'wx'+randomUUID().replaceAll('-','').slice(0,28)},
     {uid:11,key:randomUUID(),cartIds:rows.map(row=>row.id),addressId:11,userIp:'127.0.0.1',useIntegral:true,payType:'offline',from:'pc'});
    await new StoreOrderPayService(runtime.container,f.paymentEnvironment).offlinePay(11,result.orderId,'pc');
    const [actual]=await f.db.select().from(storeOrder).where(eq(storeOrder.orderId,result.orderId));
    if(!actual||actual.paid!==0)throw Error('Actual owned unpaid checkout absent');return actual;
   }):f.createOffline());
   await f.service.save(order.id,{...await f.body(order.id),pay_price:'18.75',gain_integral:'17'},supplierOrderEditActor());
   if(channel==='offline')await f.withPaymentRuntime(async(_runtime,payment)=>payment.pay(order.id,await f.paymentBody(order.id,payment),supplierOrderEditActor()));
   else await f.withPaidConsumer(async runtime=>new StoreOrderPayService(runtime.container,f.paymentEnvironment).yuePay(11,order.orderId));
   await f.consumePaid(order.id);return order.id;
  };
  type Runtime=Parameters<Parameters<typeof f.withManualRuntime>[0]>[0];
  const withWriter=<T>(work:(runtime:Runtime,service:SupplierProactiveRefundService)=>Promise<T>)=>f.withManualRuntime(async runtime=>{
   await f.db.transaction(tx=>installSupplierProactiveRefund(tx,{runtimeRole:runtime.role}));
   await f.exec(`GRANT SELECT,INSERT ON public.capital_flow TO "${runtime.role}"; GRANT USAGE ON SEQUENCE public.capital_flow_id_seq TO "${runtime.role}"`);
   await grantBusinessReads(runtime.role);
   return work(runtime,new SupplierProactiveRefundService(runtime.container,supplierOrderEditAppKey,f.paymentEnvironment));
  });
  const execute=async(service:SupplierProactiveRefundService,id:number,amount:string)=>{
   const seed=await service.seed(id,supplierOrderEditActor());
   const body={operation_id:randomUUID(),revision:seed.revision,refund_price:amount,
    ...(seed.settlement==='cash'?{cash_returned:true as const}:{})};
   return{body,result:await service.execute(id,body,supplierOrderEditActor())};
  };
  const withReader=<T>(work:(reader:{container:Container;role:string;db:typeof f.db;pid:number;exec:(statement:string)=>Promise<unknown>},commission:()=>Promise<void>)=>Promise<T>)=>{
   if(!f.withRuntimeRole)throw Error('Settlement reader requires owned native PG16 LOGIN');
   return f.withRuntimeRole(async peer=>{
    // SELECT subset of already published business profiles. No Supplier proof
    // access, DML, sequence or function privilege is smuggled into this setup.
    await grantBusinessReads(peer.role);
    return work({...peer,container:createContainerFromDb(peer.db)},()=>runSupplierRefundSettlementRead(f.db,peer.role));
   });
  };
  const snapshot=async()=>({...await f.manualSnapshot(),flows:await f.db.select().from(capitalFlow).orderBy(capitalFlow.id),
   invoices:await f.db.select().from(storeOrderInvoice).orderBy(storeOrderInvoice.id),
   proactive:await f.exec('SELECT * FROM public.supplier_proactive_refund_operation_v1 ORDER BY operation_id'),
   decisions:await f.exec('SELECT * FROM public.supplier_proactive_refund_decision_v1 ORDER BY operation_id'),
   money_completions:await f.exec('SELECT * FROM public.supplier_refund_money_completion_v1 ORDER BY operation_id'),
   money_payments:await f.exec('SELECT * FROM public.supplier_refund_money_payment_v1 ORDER BY operation_id')});
  return{...f,paid,withWriter,execute,withReader,snapshot};
 }catch(error){await f.close();throw error;}
}
