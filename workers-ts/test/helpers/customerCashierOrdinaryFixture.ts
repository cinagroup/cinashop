import {eq,is,sql} from 'drizzle-orm';
import {PgTable,getTableConfig} from 'drizzle-orm/pg-core';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import type {DbClient} from '../../src/lib/di';
import {runtimeBusinessPrivilegePlan} from '../../src/migrations/runtimeBusinessPrivilegePlan';
import * as schema from '../../src/models/schema';
import {customerWorkFinancialFixture} from './customerWorkFinancialFixture';
import {runCashierOrdinary,cashierOrdinaryReadiness} from '../../src/migrations/runCashierOrdinary';
import {CASHIER_ORDINARY_TABLES} from '../../src/migrations/cashierOrdinary';
import {CASHIER_ORDINARY_SOURCE_READ_TABLES,inspectCashierOrdinarySourceRights} from '../../src/migrations/cashierOrdinarySourceRights';
import {cashierOrdinaryRuntimePrivilegePlan} from '../../src/migrations/cashierOrdinaryRuntimePlan';
import {installCashierSecondCardPromotionLock,cashierSecondCardPromotionLockGrantSql} from '../../src/migrations/cashierSecondCardPromotionLock';
import {CustomerWorkOrdinaryCashierService} from '../../src/services/customer-work/CustomerWorkOrdinaryCashierService';
import {CustomerWorkOrdinaryCashierReadService} from '../../src/services/customer-work/CustomerWorkOrdinaryCashierReadService';
import {authorizeCustomerWorkActor} from '../../src/services/customer-work/CustomerWorkScope';
import {installCustomerProductCatalogLock} from '../../src/migrations/runCustomerProductCatalogLock';
import {installCustomerUserCatalogLock} from '../../src/migrations/runCustomerUserCatalogLock';
import {OrderOutboxService} from '../../src/services/order/OrderOutboxService';
import type {StoreOrderCreationRuntime} from '../../src/services/order/StoreOrderCreateService';
import type {OrdinaryCashierDraft,OrdinaryCashierIntent} from '../../src/services/customer-work/CustomerOrdinaryCashierContract';

/** Reuses genuine registered PG16 checkout and an independent LOGIN. Extra
 * source tables are complete ORM columns, never synthetic paid/origin rows.
 * Only fixture-owned maintenance installs new realms and reviewed grants. */
export async function customerCashierOrdinaryFixture(){
 const needed=new Set<string>(CASHIER_ORDINARY_SOURCE_READ_TABLES.filter(t=>t!=='store_order_purchase_origin'));
 const models=Object.fromEntries(Object.entries(schema).filter(([,value])=>is(value,PgTable)&&needed.has(getTableConfig(value).name)));
 const found=new Set(Object.values(models).map(t=>getTableConfig(t as PgTable).name));
 for(const name of needed)if(!found.has(name))throw Error('Ordinary required actual ORM source absent: '+name);
 const f=await customerWorkFinancialFixture(Object.values(models) as PgTable[]);
 const catalogOwners:string[]=[];
 const close=async()=>{try{for(const owner of [...catalogOwners].reverse())await f.exec(`DROP OWNED BY "${owner}";DROP ROLE "${owner}"`);catalogOwners.length=0;}finally{await f.close();}};
 try{
  const kit=await import('drizzle-kit/api'),indexModels={storeOrderEconomize:schema.storeOrderEconomize,paymentReconciliationCase:schema.paymentReconciliationCase,
   storeOrderPromotions:schema.storeOrderPromotions,userLabelRelation:schema.userLabelRelation,storeOrderProductCouponReward:schema.storeOrderProductCouponReward,
   storeOrderPromotionGiftCouponReward:schema.storeOrderPromotionGiftCouponReward,agentLevelTaskRecord:schema.agentLevelTaskRecord};
  for(const statement of await kit.generateMigration(kit.generateDrizzleJson({}),kit.generateDrizzleJson(indexModels)))if(/^CREATE (?:UNIQUE )?INDEX/.test(statement.trim()))await f.exec(statement);
  await runCashierOrdinary(f.maintenanceDb);
  const target='"'+f.role+'"',plan=cashierOrdinaryRuntimePrivilegePlan();
  for(const name of needed){const rights=plan.tables[name];if(!rights)throw Error('Reviewed ordinary source grant absent '+name);
   await f.exec(`GRANT ${rights.join(',')} ON public."${name}" TO ${target}`);
   const columns=plan.updateColumns[name];if(columns?.length&&name!=='store_order_promotions')await f.exec(`GRANT UPDATE(${columns.map(c=>'"'+c+'"').join(',')}) ON public."${name}" TO ${target}`);}
  for(const table of CASHIER_ORDINARY_TABLES)await f.exec(`GRANT SELECT,INSERT ON public."${table}" TO ${target}`);
  for(const kind of ['product','user'] as const){const owner=`ordinary_${kind}_catalog_${randomUUID().replaceAll('-','')}`;
   await f.exec(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);catalogOwners.push(owner);
   if(kind==='product')await installCustomerProductCatalogLock(f.maintenanceDb,owner);else await installCustomerUserCatalogLock(f.maintenanceDb,owner);
   await f.exec(`GRANT EXECUTE ON FUNCTION public.customer_${kind}_lock_catalog_v1(text,integer[]) TO ${target}`);}
  await installCashierSecondCardPromotionLock(f.maintenanceDb,f.role);await f.exec(cashierSecondCardPromotionLockGrantSql(f.role));
  const sequences=await f.maintenanceDb.execute<{name:string;table:string}>(sql`SELECT s.relname AS name,t.relname AS "table" FROM pg_catalog.pg_class s
   JOIN pg_catalog.pg_depend d ON d.objid=s.oid AND d.deptype IN('a','i') JOIN pg_catalog.pg_class t ON t.oid=d.refobjid WHERE s.relkind='S'`);
  for(const sequence of sequences)if(needed.has(sequence.table)&&plan.tables[sequence.table]?.includes('INSERT'))await f.exec(`GRANT USAGE ON SEQUENCE public."${sequence.name}" TO ${target}`);
  const rights=await inspectCashierOrdinarySourceRights(f.db);if(!rights.ready)throw Error('Actual ordinary source privileges incomplete: '+JSON.stringify(rights));
  const commissioned=await cashierOrdinaryReadiness(f.db);if(!commissioned.ready)throw Error('Actual ordinary independent LOGIN is not commissioned: '+JSON.stringify(commissioned));
  let serial=0;const runtime:StoreOrderCreationRuntime={CONFIG_KV:f.env.CONFIG_KV,requirePurchaseOrigin:true,nextOrderId:async()=>`ORD-${Date.now()}-${++serial}`};
  const service=new CustomerWorkOrdinaryCashierService(f.container,f.env,runtime),reader=new CustomerWorkOrdinaryCashierReadService(f.container,f.env);
  const reset=async(price='5.00')=>{
   await f.maintenanceDb.transaction(async tx=>{for(const table of CASHIER_ORDINARY_TABLES)await tx.execute(sql.raw(`ALTER TABLE public.${table} DISABLE TRIGGER USER`));
    await tx.execute(sql.raw(`TRUNCATE ${CASHIER_ORDINARY_TABLES.map(t=>'public.'+t).join(',')}`));
    for(const table of CASHIER_ORDINARY_TABLES)await tx.execute(sql.raw(`ALTER TABLE public.${table} ENABLE TRIGGER USER`));});
   await f.reset();await f.maintenanceDb.delete(schema.storeOrderCartInfo);await f.maintenanceDb.delete(schema.storeOrder);await f.maintenanceDb.delete(schema.storeCart);
   await f.maintenanceDb.delete(schema.storeOrderStatus);await f.maintenanceDb.delete(schema.storeOrderPromotions);await f.maintenanceDb.delete(schema.storeOrderOutbox);
   await f.maintenanceDb.delete(schema.storePromotionsAuxiliary);await f.maintenanceDb.delete(schema.storePromotions);await f.maintenanceDb.delete(schema.storeProductRelation);
   await f.maintenanceDb.delete(schema.storeCouponUser);await f.maintenanceDb.delete(schema.storeCouponIssue);
   await f.maintenanceDb.delete(schema.storeOrderPromotionGiftCouponReward);await f.maintenanceDb.delete(schema.userLabelRelation);await f.maintenanceDb.delete(schema.userLabel);
   await f.maintenanceDb.delete(schema.systemFormData);await f.maintenanceDb.delete(schema.systemForm);await f.maintenanceDb.delete(schema.systemAttachment);
   await f.maintenanceDb.delete(schema.userLevel).where(eq(schema.userLevel.uid,11));await f.maintenanceDb.delete(schema.memberRight);
   await f.maintenanceDb.delete(schema.systemUserLevel).where(eq(schema.systemUserLevel.id,81));await f.maintenanceDb.delete(schema.storeProductCategory).where(eq(schema.storeProductCategory.id,81));
   await f.maintenanceDb.delete(schema.storeBrand).where(eq(schema.storeBrand.id,81));await f.maintenanceDb.delete(schema.user).where(eq(schema.user.uid,201));
   await f.maintenanceDb.delete(schema.storeProductAttrValue).where(eq(schema.storeProductAttrValue.productId,71));await f.maintenanceDb.delete(schema.storeProduct).where(eq(schema.storeProduct.id,71));
   await f.maintenanceDb.update(schema.user).set({isEverLevel:0,isMoneyLevel:0,overdueTime:0,spreadUid:0,isPromoter:0,level:0,levelStatus:1}).where(eq(schema.user.uid,11));
   await f.maintenanceDb.delete(schema.storeProductAttrValue).where(eq(schema.storeProductAttrValue.id,2));
   await f.maintenanceDb.update(schema.storeProduct).set({type:0,relationId:0,pid:0,productType:0,isPresaleProduct:0,isVip:0,isVipProduct:0,freight:2,image:'/api/qa/image.svg',cateId:'',brandId:0,
    stock:100,sales:0,price,giveIntegral:'0.00',systemFormId:0}).where(eq(schema.storeProduct.id,70));
   await f.maintenanceDb.update(schema.storeProductAttrValue).set({price,vipPrice:price,stock:100,sales:0,writeTimes:1,writeValid:1}).where(eq(schema.storeProductAttrValue.id,1));
   const[base]=await f.maintenanceDb.select().from(schema.storeProductAttrValue).where(eq(schema.storeProductAttrValue.id,1));
   await f.maintenanceDb.insert(schema.storeProductAttrValue).values({...base,id:2,unique:'qablue02',suk:'蓝色',price:price==='0.00'?'0.00':'7.00',stock:100,sales:0});
   await f.setConfig({...Object.fromEntries(Object.keys(f.config).map(key=>[key,'0'])),store_func_status:'1',store_self_mention:'1',integral_ratio_status:'1',integral_ratio:'0.01',integral_max_type:'1',integral_max_num:'50'});
   for(const key of ['first_order_status','newcomer_status','brokerage_func_status','store_brokerage_statu','order_give_integral','order_give_exp']){
    await f.maintenanceDb.delete(schema.systemConfig).where(eq(schema.systemConfig.menuName,key));await f.maintenanceDb.insert(schema.systemConfig).values({menuName:key,value:'0'});}
  };
  const draft=async(overrides:Partial<OrdinaryCashierDraft>={})=>{const scope=await authorizeCustomerWorkActor(f.db,f.actor()),key=randomUUID();
   const input={version:'customer-cashier-ordinary-v1',scope_key:scope.scope_key,buyer_uid:11,tourist_key:'',rows:[{product_id:70,sku_unique:'qared001',quantity:2},{product_id:70,sku_unique:'qablue02',quantity:1}],...overrides};
   const result=await service.draft(f.actor(),key,input),saved=result.receipt.evidence.draft as {draft_hash:string;rows:Array<{cart_id:number}>};
   const intent:OrdinaryCashierIntent={version:'customer-cashier-ordinary-v1',scope_key:scope.scope_key,draft_key:key,draft_hash:saved.draft_hash,buyer_uid:input.buyer_uid,tourist_key:input.tourist_key,
    coupon_id:0,use_integral:false,shipping_type:2,store_id:0,address_id:0,manual_address:null,real_name:input.buyer_uid?'实际购买人':'',user_phone:input.buyer_uid?'00000000000':'',mark:'',custom_form:[]};
   return{key,input,result,intent,rows:saved.rows};};
  const create=async(intentOverrides:Partial<OrdinaryCashierIntent>={},draftOverrides:Partial<OrdinaryCashierDraft>={})=>{const source=await draft(draftOverrides),intent={...source.intent,...intentOverrides},key=randomUUID();
   const quote=await service.quote(f.actor(),key,intent),result=await service.create(f.actor(),key,intent,quote.data.quote_token),actual=result.receipt.evidence.order as {order_id:number};
   const[order]=await f.db.select().from(schema.storeOrder).where(eq(schema.storeOrder.id,actual.order_id));if(!order)throw Error('Actual ordinary core order absent');return{source,intent,key,quote,result,order};};
  const cash=async(order:typeof schema.storeOrder.$inferSelect,uid=101,key=randomUUID())=>service.cash(f.actor(uid),key,{version:'customer-cashier-ordinary-payment-v1',
   scope_key:(await authorizeCustomerWorkActor(f.db,f.actor(uid))).scope_key,order_id:order.id,order_no:order.orderId,expected_amount:order.payPrice});
  const processPaid=async(id:number)=>{const[event]=await f.db.select().from(schema.storeOrderOutbox).where(eq(schema.storeOrderOutbox.aggregateId,id));if(!event)throw Error('Original ordinary paid event absent');
   return new OrderOutboxService(f.container,f.env).processMessage({action:'processOrderPaidOutbox',outboxId:event.id,eventKey:event.eventKey});};
  const actual=async(id:number)=>{const[order]=await f.db.select().from(schema.storeOrder).where(eq(schema.storeOrder.id,id));const carts=await f.db.select().from(schema.storeOrderCartInfo).where(eq(schema.storeOrderCartInfo.oid,id));return{order,carts};};
  /** Original fixed app plan on this registered fixture cohort. This does not
   * claim whole-shop profile admission and grants no ordinary realms/routines. */
  const withMatureApp=async<T>(callback:(db:DbClient)=>Promise<T>)=>{const role=`ordinary_legacy_app_${randomUUID().replaceAll('-','')}`,password=randomUUID().replaceAll('-','');let client:ReturnType<typeof postgres>|undefined;
   await f.exec(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
   try{const target=new URL(f.connectionString);target.username=role;target.password=password;const database=target.pathname.slice(1);if(!/^[a-z_][a-z_0-9]*$/.test(database))throw Error('Registered app fixture database identifier invalid');
    await f.exec(`GRANT CONNECT ON DATABASE "${database}" TO "${role}";GRANT USAGE ON SCHEMA public TO "${role}"`);
    const original=runtimeBusinessPrivilegePlan('app'),tables=await f.maintenanceDb.execute<{name:string}>(sql`SELECT relname AS name FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'`);
    for(const{name}of tables){if(!/^[a-z_][a-z_0-9]*$/.test(name))throw Error('Registered app fixture table identifier invalid');const rights=original.tables[name];if(rights?.length)await f.exec(`GRANT ${rights.join(',')} ON public."${name}" TO "${role}"`);
     const columns=original.updateColumns[name];if(columns?.length)await f.exec(`GRANT UPDATE(${columns.map(c=>'"'+c+'"').join(',')}) ON public."${name}" TO "${role}"`);}
    for(const sequence of sequences)if(original.tables[sequence.table]?.includes('INSERT'))await f.exec(`GRANT USAGE ON SEQUENCE public."${sequence.name}" TO "${role}"`);
    for(const signature of original.functions){const[present]=await f.maintenanceDb.execute<{present:boolean}>(sql`SELECT to_regprocedure(${`public.${signature}`}) IS NOT NULL AS present`);if(present.present)await f.exec(`GRANT EXECUTE ON FUNCTION public.${signature} TO "${role}"`);}
    client=postgres(target.href,{max:1,prepare:false,connect_timeout:5,idle_timeout:0,max_lifetime:0,connection:{options:'-c search_path=public,pg_temp -c statement_timeout=10000 -c lock_timeout=3000'}});
    const db=drizzle(client) as unknown as DbClient,[identity]=await db.execute<{role:string;session:string;ordinary_read:boolean;label_lock:boolean;ordinary_function:boolean}>(sql`SELECT current_user AS role,session_user AS session,
     has_table_privilege(current_user,'public.cashier_ordinary_origin_v1','SELECT') AS ordinary_read,has_column_privilege(current_user,'public.user_label','id','UPDATE') AS label_lock,
     has_function_privilege(current_user,'public.customer_user_lock_catalog_v1(text,integer[])','EXECUTE') AS ordinary_function`);
    if(identity.role!==role||identity.session!==role||identity.ordinary_read||!identity.label_lock||identity.ordinary_function)throw Error('Original actual app privilege boundary was not exact');
    console.log('ORDINARY_ORIGINAL_APP_FIXTURE_BOUNDARY '+JSON.stringify(identity));return await callback(db);
   }finally{await client?.end({timeout:5});await f.exec(`DROP OWNED BY "${role}";DROP ROLE "${role}"`);}};
  await reset();return{...f,close,reset,service,reader,runtime,draft,create,cash,processPaid,actual,withMatureApp};
 }catch(error){await close();throw error;}
}
