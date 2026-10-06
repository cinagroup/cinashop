import {and,eq,sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {customerWorkFinancialFixture} from './customerWorkFinancialFixture';
import {runCustomerWriteoffOperation} from '../../src/migrations/runCustomerWriteoffOperation';
import {CUSTOMER_WRITEOFF_FUNCTIONS} from '../../src/migrations/customerWriteoffRuntimePlan';
import {runCashierSecondCardOrigin,cashierSecondCardOriginReadiness} from '../../src/migrations/runCashierSecondCardOrigin';
import {CASHIER_SECOND_CARD_FUNCTIONS,CASHIER_SECOND_CARD_TABLES,CASHIER_SECOND_CARD_PURCHASE_APPEND_TABLES,cashierSecondCardRuntimePrivilegePlan} from '../../src/migrations/cashierSecondCardRuntimePlan';
import {storeCart,storeOrder,storeOrderCartInfo,storeProduct,storeProductAttrValue,storeOrderStatus,storeOrderPromotions,systemConfig,paymentReconciliationCase,storeOrderEconomize} from '../../src/models/schema';
import {authorizeCustomerWorkActor} from '../../src/services/customer-work/CustomerWorkScope';
import {createCustomerCashierSecondCardWithRuntime,applyCustomerCashierCashPayment,type CustomerCashierNativeInput} from '../../src/services/customer-work/CustomerWorkCashierService';
import {OrderOutboxService} from '../../src/services/order/OrderOutboxService';
import type {StoreOrderCreationRuntime} from '../../src/services/order/StoreOrderCreateService';
import {installCashierSecondCardPromotionLock,inspectCashierSecondCardPromotionLock,cashierSecondCardPromotionLockGrantSql} from '../../src/migrations/cashierSecondCardPromotionLock';

/** Reuses the maintained PG16 column/checkout authority fixture, then grants
 * only these new append-only tables to its existing independently logged-in
 * customer role. Maintenance never executes a business create/payment. */
export async function customerCashierSecondCardFixture(){
  const f=await customerWorkFinancialFixture();
  try{
    // The inherited fixture intentionally provides columns. These actual ORM
    // indexes are required by the unchanged paid-event and reconciliation
    // ON CONFLICT writers; an index-free clone cannot verify that business path.
    const kit=await import('drizzle-kit/api');
    for(const statement of await kit.generateMigration(kit.generateDrizzleJson({}),kit.generateDrizzleJson({storeOrderEconomize,paymentReconciliationCase,storeOrderPromotions})))
      if(/^CREATE (?:UNIQUE )?INDEX/.test(statement.trim()))await f.exec(statement);
    await runCustomerWriteoffOperation(f.maintenanceDb);await runCashierSecondCardOrigin(f.maintenanceDb);
    const target=`"${f.role}"`;
    for(const table of ['customer_writeoff_operation_request',...CASHIER_SECOND_CARD_TABLES])await f.exec(`GRANT SELECT,INSERT ON public."${table}" TO ${target}`);
    const profile=cashierSecondCardRuntimePrivilegePlan(),promotionPrivileges=profile.tables.store_order_promotions;
    if(JSON.stringify(CASHIER_SECOND_CARD_PURCHASE_APPEND_TABLES)!==JSON.stringify(['store_order_promotions'])||JSON.stringify(promotionPrivileges)!==JSON.stringify(['SELECT','INSERT'])||JSON.stringify(profile.updateColumns.store_order_promotions)!==JSON.stringify(['id']))throw Error('Reviewed cashier profile lacks exact append/read and guarded-id order-promotion capability');
    await f.exec(`GRANT ${promotionPrivileges.join(',')} ON public.store_order_promotions TO ${target}`);
    const ownedPromotionSequences=await f.maintenanceDb.execute<{name:string}>(sql`SELECT s.relname AS name FROM pg_catalog.pg_class s JOIN pg_catalog.pg_namespace n ON n.oid=s.relnamespace JOIN pg_catalog.pg_depend d ON d.objid=s.oid AND d.deptype IN('a','i') JOIN pg_catalog.pg_class t ON t.oid=d.refobjid JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid WHERE s.relkind='S' AND n.nspname='public' AND t.oid='public.store_order_promotions'::regclass AND a.attname='id'`);
    if(ownedPromotionSequences.length!==1||!/^store_order_promotions_id_seq$/.test(ownedPromotionSequences[0].name))throw Error('Actual cashier order-promotion sequence ownership is incomplete');
    await f.exec(`GRANT USAGE ON SEQUENCE public.${ownedPromotionSequences[0].name} TO ${target}`);
    await installCashierSecondCardPromotionLock(f.maintenanceDb,f.role);
    if(!(await inspectCashierSecondCardPromotionLock(f.maintenanceDb,f.role)).ready)throw Error('Actual cashier promotion lock guard was not installed and verified');
    await f.exec(cashierSecondCardPromotionLockGrantSql(f.role));
    for(const fn of [...CUSTOMER_WRITEOFF_FUNCTIONS,...CASHIER_SECOND_CARD_FUNCTIONS])await f.exec(`GRANT EXECUTE ON FUNCTION public.${fn} TO ${target}`);
    if(!(await cashierSecondCardOriginReadiness(f.db)).ready)throw Error('Actual cashier customer LOGIN is not commissioned');
    const reset=async(price='7.00')=>{
      await f.exec('TRUNCATE public.cashier_second_card_cart_v1,public.cashier_second_card_origin_v1,public.cashier_second_card_payment_v1,public.customer_writeoff_operation_request');
      await f.exec('ALTER TABLE public.store_order_purchase_origin DISABLE TRIGGER USER;TRUNCATE public.store_order_purchase_origin;ALTER TABLE public.store_order_purchase_origin ENABLE TRIGGER USER');
      await f.reset();await f.maintenanceDb.delete(storeCart);await f.maintenanceDb.delete(storeOrderCartInfo);await f.maintenanceDb.delete(storeOrder);
      await f.maintenanceDb.delete(storeOrderStatus);await f.maintenanceDb.delete(storeOrderPromotions);await f.maintenanceDb.delete(paymentReconciliationCase);
      await f.maintenanceDb.update(storeProduct).set({productType:4,isVip:0,stock:10,sales:0,freight:1,postage:'0.00',giveIntegral:'0.00',isSupportRefund:1})
        .where(eq(storeProduct.id,70));
      await f.maintenanceDb.update(storeProductAttrValue).set({price,vipPrice:price,writeTimes:3,writeValid:2,writeDays:10,writeStart:0,writeEnd:0,stock:10,sales:0})
        .where(and(eq(storeProductAttrValue.productId,70),eq(storeProductAttrValue.type,0)));
      await f.maintenanceDb.update(systemConfig).set({value:'0'}).where(sql`${systemConfig.menuName} IN('first_order_status','newcomer_status')`);
    };
    let serial=0;const runtime:StoreOrderCreationRuntime={CONFIG_KV:f.env.CONFIG_KV,requirePurchaseOrigin:true,
      nextOrderId:async()=>`CASHIER-${Date.now()}-${++serial}`};
    const input=async(overrides:Partial<CustomerCashierNativeInput>={}):Promise<CustomerCashierNativeInput>=>{
      const scope=await authorizeCustomerWorkActor(f.db,f.actor());
      return{request_key:randomUUID(),version:'customer-cashier-second-card-v1',scope_key:scope.scope_key,buyer_uid:11,tourist_key:'',
        product_id:70,sku_unique:'qared001',quantity:2,real_name:'真实购买人',user_phone:'00000000000',mark:'',custom_form:[],coupon_id:0,use_integral:false,...overrides};};
    const create=async(selected?:CustomerCashierNativeInput)=>{const value=selected??await input();const result=await createCustomerCashierSecondCardWithRuntime(f.container,runtime,f.actor(),value);
      const[order]=await f.db.select().from(storeOrder).where(eq(storeOrder.orderId,result.orderId)).limit(1);
      if(!order)throw Error('Actual cashier order is absent');return{order,input:value,result};};
    const cash=async(order:typeof storeOrder.$inferSelect,key=randomUUID())=>applyCustomerCashierCashPayment(f.container,f.actor(),{
      request_key:key,version:'customer-cashier-second-card-payment-v1',scope_key:(await authorizeCustomerWorkActor(f.db,f.actor())).scope_key,
      order_id:order.id,order_no:order.orderId,expected_amount:order.payPrice});
    const processPaid=async(outbox:{id:number;eventKey:string})=>new OrderOutboxService(f.container,f.env)
      .processMessage({action:'processOrderPaidOutbox',outboxId:outbox.id,eventKey:outbox.eventKey});
    const actual=async(orderId:number)=>{const[order]=await f.db.select().from(storeOrder).where(eq(storeOrder.id,orderId)).limit(1);
      const carts=await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,orderId));return{order,carts};};
    await reset();return{...f,reset,runtime,input,create,cash,processPaid,actual};
  }catch(error){await f.close();throw error;}
}
