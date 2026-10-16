/** Owned PG16 acceptance only. Creation, offline selection, Supplier collection,
 * paid consumer and refund applications all use actual services. No paid/refund
 * state is manufactured by the maintenance connection. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {withTx,createContainerFromDb} from '@/lib/di';
import {storeOrder,storeOrderCartInfo} from '@/models/schema';
import {installCashierSecondCardPromotionLock,cashierSecondCardPromotionLockGrantSql} from '@/migrations/cashierSecondCardPromotionLock';
import {installSupplierManualRefund,assertSupplierManualRefundReady} from '@/migrations/supplierManualRefund';
import {applyOrderRefundWithMaterialization} from '@/services/order/StoreOrderRefundService';
import {prepareSupplierManualRefundApplication} from '@/services/supplier/SupplierManualRefundProof';
import {SupplierManualRefundService} from '@/services/supplier/SupplierManualRefundService';
import {supplierOfflinePaymentFixture} from './supplierOfflinePayment';
import {supplierOrderEditActor,supplierOrderEditAppKey} from './supplierUnpaidOrderEdit';
export async function supplierManualRefundFixture() {
  const f=await supplierOfflinePaymentFixture(),promotionOwner='supplier_refund_owner_'+randomUUID().replaceAll('-',''),
    channelLockOwner='supplier_refund_channel_'+randomUUID().replaceAll('-','');
  let created=false;
  try {
    await f.exec(`CREATE ROLE "${promotionOwner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      CREATE ROLE "${channelLockOwner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);created=true;
    const manualService=new SupplierManualRefundService(f.container,supplierOrderEditAppKey,f.paymentEnvironment);
    const paid=async()=>{const order=await f.createOffline();await f.withPaymentRuntime(async(_runtime,payment)=>{
      await payment.pay(order.id,await f.paymentBody(order.id,payment),supplierOrderEditActor());
    });await f.consumePaid(order.id);return order.id;};
    const paidPhp=async()=>{
      const order=await f.createOffline(),original=await f.editState(order.id);
      // Only the finite owned unpaid purchase is projected into the genuine
      // complete PHP shape. Actual collection and paid effects still use the
      // independent runtime services; no paid/audit/refund row is manufactured.
      for(const row of original.carts) {
        const info=JSON.parse(row.cartInfo!),product=info.product,sku=info.sku;
        for(const field of ['financial_version','product','sku','member_savings_version','paid_member','member_postage_price','member_coupon_price'])delete info[field];
        info.productInfo={id:row.productId,store_name:product.storeName,give_integral:product.giveIntegral,attrInfo:{...sku}};
        await f.db.update(storeOrderCartInfo).set({type:0,relationId:0,cartInfo:JSON.stringify(info)}).where(eq(storeOrderCartInfo.id,row.id));
      }
      await f.withPaymentRuntime(async(_runtime,payment)=>payment.pay(order.id,await f.paymentBody(order.id,payment),supplierOrderEditActor()));
      await f.consumePaid(order.id);return order.id;
    };
    const snapshot=async()=>({...await f.paymentState(),
      manual_operations:await f.exec('SELECT * FROM public.supplier_manual_refund_operation_v1 ORDER BY operation_id'),
      manual_proofs:await f.exec('SELECT * FROM public.supplier_manual_refund_proof_v1 ORDER BY refund_id')});
    type Runtime=Parameters<Parameters<typeof f.withRuntime>[0]>[0];
    const withManualRuntime=<T>(work:(runtime:Runtime,service:SupplierManualRefundService)=>Promise<T>)=>f.withRuntime(async runtime=>{
      await f.exec(`GRANT SELECT,UPDATE ON public.system_admin,public.system_supplier,public.system_role,public.system_menus TO "${runtime.role}";
        GRANT SELECT ON public.supplier_offline_payment_operation_v1,public.supplier_order_edit_operation_v1 TO "${runtime.role}";
        GRANT SELECT,INSERT ON public.store_order_promotions TO "${runtime.role}";
        GRANT USAGE ON SEQUENCE public.store_order_promotions_id_seq TO "${runtime.role}"`);
      await installCashierSecondCardPromotionLock(f.db,runtime.role);
      await f.exec(cashierSecondCardPromotionLockGrantSql(runtime.role));
      await f.db.transaction(tx=>installSupplierManualRefund(tx,{promotionOwner,channelLockOwner,runtimeRole:runtime.role}));
      await withTx(runtime.container,tx=>assertSupplierManualRefundReady(tx));
      return work(runtime,new SupplierManualRefundService(runtime.container,supplierOrderEditAppKey,f.paymentEnvironment));
    });
    const apply=async(runtime:Runtime,id:number,quantity=1)=>withTx(runtime.container,async tx=>{
      await tx.execute(sql`LOCK TABLE ONLY public.system_admin,ONLY public.system_supplier,ONLY public.system_role,ONLY public.system_menus IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
      const [order]=await tx.select().from(storeOrder).where(eq(storeOrder.id,id));
      const carts=await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,id)).orderBy(storeOrderCartInfo.id);
      if(!order||order.supplierId!==7||!carts.length)throw Error('Actual owned Supplier refund source absent');
      const cap=await prepareSupplierManualRefundApplication(tx,supplierOrderEditActor(),order);
      const result=await applyOrderRefundWithMaterialization(createContainerFromDb(tx),{uid:order.uid,orderId:order.orderId,
        privilegedActor:'supplier',selectorNamespace:'row',supplierManualRefundCapability:cap,applyType:4,
        cartSelections:quantity===0?carts.map(c=>({cartId:c.id,cartNum:c.cartNum})):[{cartId:carts[0].id,cartNum:quantity}],
        refundReason:'真实供应商现金退回',refundExplain:'actual owned Supplier proof',
        applicationOrderId:'srf'+randomUUID().replaceAll('-','').slice(0,27),authorizeApplication:async(_db,current)=>{
          if(current.id!==id||current.supplierId!==7)throw Error('Actual Supplier application binding changed');
        }},0);
      return result.refundId;
    });
    const manualBody=async(service:SupplierManualRefundService,id:number)=>{const seed=await service.seed(id,supplierOrderEditActor());return{
      operation_id:randomUUID(),revision:seed.revision,refund_price:seed.refund_price,...seed.settlement==='cash'?{cash_returned:true as const}:{}};};
    const close=async()=>{try{if(created){await f.exec(`DROP OWNED BY "${promotionOwner}";DROP ROLE "${promotionOwner}";
      DROP OWNED BY "${channelLockOwner}";DROP ROLE "${channelLockOwner}"`);created=false;}}finally{await f.close();}};
    return {...f,promotionOwner,channelLockOwner,manualService,paid,paidPhp,manualSnapshot:snapshot,withManualRuntime,apply,manualBody,close};
  } catch(error) {try{if(created)await f.exec(`DROP OWNED BY "${promotionOwner}";DROP ROLE "${promotionOwner}";
    DROP OWNED BY "${channelLockOwner}";DROP ROLE "${channelLockOwner}"`);}finally{await f.close();}throw error;}
}
