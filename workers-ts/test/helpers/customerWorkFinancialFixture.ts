import {sql} from 'drizzle-orm';
import {getTableConfig} from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {URL as NodeURL} from 'node:url';
import * as schema from '../../src/models/schema';
import {createContainerFromDb,withTx,type DbClient} from '../../src/lib/di';
import type {Env} from '../../src/env';
import {customerRefundApplicationFixture} from './customerRefundApplicationFixture';
import {customerReadTables} from './customerWorkReadFixture';
import {validateFinanceFixtureUrl,ownsFinanceFixtureEndpoint} from './financePostgres';
import {runCustomerFinancialOperation} from '../../src/migrations/runCustomerFinancialOperation';
import {customerFinancialRuntimePrivilegePlan,CUSTOMER_FINANCIAL_FUNCTIONS} from '../../src/migrations/customerFinancialRuntimePlan';
import {CUSTOMER_WORK_LOCK_FUNCTIONS} from '../../src/migrations/customerWorkRuntimePrivilegePlan';
import {installCustomerWorkScopeLock} from '../../src/migrations/runCustomerWorkScopeLock';
import {runCustomerWaybillActor} from '../../src/migrations/runCustomerWaybillActor';
import {installCustomerCityDelivery} from '../../src/migrations/customerCityDelivery';
import {runInvoiceEvidence,runInvoiceEvidenceSchema} from '../../src/migrations/runInvoiceEvidence';
import {runRefundOrderSplit,runRefundOrderSplitSchema} from '../../src/migrations/runRefundOrderSplit';
import {auditCheckoutPricingLockRuntime} from '../../src/migrations/checkoutPricingLock';
import {md5} from '../../src/utils/jwt';
import type {CustomerWorkActor} from '../../src/services/customer-work/CustomerWorkScope';
import {CustomerWorkFinancialService} from '../../src/services/customer-work/CustomerWorkFinancialService';
import {StoreOrderCreateService} from '../../src/services/order/StoreOrderCreateService';
import {applyStoreOrderBalancePayment} from '../../src/services/order/StoreOrderPayService';
import {OrderOutboxService} from '../../src/services/order/OrderOutboxService';
import {readPurchaseOriginEvidence} from '../../src/services/order/PurchaseOriginEvidence';

const ident=(value:string)=>{if(!/^[a-z_][a-z_0-9]*$/.test(value))throw Error('Invalid owned customer financial fixture identifier');return`"${value}"`;};
const protocolTables=new Set(['order_waybill_job','order_waybill_job_action','customer_city_delivery_job','customer_city_delivery_attempt','customer_city_delivery_binding','store_order_refund_split','store_order_fulfillment_branch']);
/** Real ordinary independent LOGIN on a registered disposable native PG16 DB.
 * Maintenance installation and reset stay on the separate owned fixture role. */
export async function customerWorkFinancialFixture(){
 const f=await customerRefundApplicationFixture([...customerReadTables.filter(x=>!protocolTables.has(getTableConfig(x).name)),schema.storeOrderRefundPayment,schema.storeOrderOutbox,schema.userBrokerage,schema.supplierFlowingWater,schema.supplierTransactions,schema.supplierExtract,schema.systemUserLevel,schema.storeSeckill,schema.storeBargain,schema.storeCombination,schema.storeIntegral,schema.storeBargainUser,schema.storePink,schema.deliveryService,schema.paymentReconciliationCase,schema.printDocument,schema.storeCouponIssue,schema.storeCouponUser,schema.storeProductVirtual,schema.storeProductCoupon,schema.storeOrderProductCouponReward,schema.storeCouponIssueUser,schema.luckLottery,schema.luckLotteryEntitlement,schema.agentLevel,schema.agentLevelTask,schema.agentLevelTaskRecord,schema.storeProductLog]);
 const role=`customer_financial_runtime_${crypto.randomUUID().replaceAll('-','')}`,scopeOwner=`customer_financial_scope_${crypto.randomUUID().replaceAll('-','')}`;let roleCreated=false,scopeCreated=false,client:ReturnType<typeof postgres>|undefined;
 const close=async()=>{try{await client?.end({timeout:5});if(roleCreated){await f.exec(`DROP OWNED BY ${ident(role)};DROP ROLE ${ident(role)}`);roleCreated=false;}if(scopeCreated){await f.exec(`DROP OWNED BY ${ident(scopeOwner)};DROP ROLE ${ident(scopeOwner)}`);scopeCreated=false;}}finally{await f.close();}};
 try{
  const base=validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL??''),[origin]=await f.db.execute<{database:string;role:string;host:string;port:number;version:number}>(sql`SELECT current_database() AS database,current_user AS role,host(inet_server_addr()) AS host,inet_server_port() AS port,current_setting('server_version_num')::integer AS version`);
  if(origin.role!=='finance_test'||Math.floor(origin.version/10000)!==16||!ownsFinanceFixtureEndpoint(origin.database,'public',base.href,origin.host,origin.port))throw Error('Customer financial fixture requires its actual registered PG16 database');
  // Reset repeatedly writes these two fixture-owned authority tables. Keep
  // background maintenance out of positive-case scheduling; real contention
  // still uses explicit held maintenance transactions and production NOWAIT.
  // This fixture-only setting does not identify the historical blocker.
  type AuthorityScheduling={database:string;role:string;schema:string;table_name:string;table_oid:string;owner:string;kind:string;options:string[]|null};
  const readAuthorityScheduling=()=>f.db.execute<AuthorityScheduling>(sql`SELECT current_database() AS database,current_user AS role,n.nspname AS schema,c.relname AS table_name,c.oid::text AS table_oid,pg_get_userbyid(c.relowner) AS owner,c.relkind::text AS kind,c.reloptions AS options FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN('store_service','system_config') ORDER BY c.relname`);
  const readPricingDefinition=async()=>{const rows=await f.db.execute<{function_oid:string;definition:string}>(sql`SELECT p.oid::text AS function_oid,pg_get_functiondef(p.oid) AS definition FROM pg_catalog.pg_proc p WHERE p.oid='public.checkout_lock_pricing_v1()'::regprocedure`);if(rows.length!==1||!/^[1-9]\d*$/.test(rows[0].function_oid)||!rows[0].definition)throw Error('Actual installed checkout pricing lock definition is absent');return{function_oid:rows[0].function_oid,definition_sha256:createHash('sha256').update(rows[0].definition,'utf8').digest('hex')};};
  const schedulingBefore=await readAuthorityScheduling(),pricingBefore=await readPricingDefinition();
  if(schedulingBefore.length!==2||schedulingBefore.some((row,index)=>row.database!==origin.database||row.role!==origin.role||row.schema!=='public'||row.owner!==origin.role||row.kind!=='r'||row.table_name!==['store_service','system_config'][index]||!/^[1-9]\d*$/.test(row.table_oid)||(row.options!==null&&JSON.stringify(row.options)!=='["autovacuum_enabled=false"]')))throw Error('Owned financial fixture authority identity/options were not exact');
  await f.exec('ALTER TABLE public.store_service SET (autovacuum_enabled=false)');
  await f.exec('ALTER TABLE public.system_config SET (autovacuum_enabled=false)');
  const schedulingAfter=await readAuthorityScheduling(),pricingAfter=await readPricingDefinition();
  if(schedulingAfter.length!==2||schedulingAfter.some((row,index)=>JSON.stringify({...row,options:schedulingBefore[index].options})!==JSON.stringify(schedulingBefore[index])||JSON.stringify(row.options)!=='["autovacuum_enabled=false"]')||JSON.stringify(pricingAfter)!==JSON.stringify(pricingBefore))throw Error('Owned financial fixture authority scheduling or installed pricing definition changed unexpectedly');
  console.log('CUSTOMER_FINANCIAL_FIXTURE_AUTHORITY_SCHEDULING '+JSON.stringify({before:schedulingBefore,after:schedulingAfter,pricing_before:pricingBefore,pricing_after:pricingAfter,historical_blocker_identified:false}));
  await f.exec(readFileSync(new NodeURL('../../migrations/0091_electronic_waybill_outbox.sql',import.meta.url),'utf8'));await runCustomerWaybillActor(f.db);await installCustomerCityDelivery(f.db,{maintenance:true});
  // The column fixture supplies only the pre-protocol invoice base. Install
  // its reviewed indexes, then let the real installers create complete protected
  // evidence/allocation/split tables; column-only copies are not ORM catalogs.
  const migration=await import('drizzle-kit/api'),indexTables={storeOrderInvoice:schema.storeOrderInvoice};for(const statement of await migration.generateMigration(migration.generateDrizzleJson({}),migration.generateDrizzleJson(indexTables)))if(statement.trim().startsWith('CREATE INDEX')||statement.trim().startsWith('CREATE UNIQUE INDEX'))await f.exec(statement);
  await runInvoiceEvidenceSchema(f.db);await runRefundOrderSplitSchema(f.db);await runCustomerFinancialOperation(f.db);await f.exec('CREATE UNIQUE INDEX customer_financial_notice_event_key ON public.store_order_outbox(event_key)');
  await f.exec(`CREATE ROLE ${ident(scopeOwner)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);scopeCreated=true;await installCustomerWorkScopeLock(f.db,scopeOwner);
  const password=crypto.randomUUID().replaceAll('-','');await f.exec(`CREATE ROLE ${ident(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);roleCreated=true;await f.exec(`GRANT CONNECT ON DATABASE ${ident(origin.database)} TO ${ident(role)};GRANT USAGE ON SCHEMA public TO ${ident(role)}`);
  const plan=customerFinancialRuntimePrivilegePlan(),rows=await f.db.execute<{name:string}>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'`),tables=rows.map(x=>x.name);for(const name of tables){const privileges=plan.tables[name];if(!privileges)continue;if(privileges.length)await f.exec(`GRANT ${privileges.join(',')} ON public.${ident(name)} TO ${ident(role)}`);const columns=plan.updateColumns[name];if(columns?.length)await f.exec(`GRANT UPDATE(${columns.map(ident).join(',')}) ON public.${ident(name)} TO ${ident(role)}`);}
  const sequences=await f.db.execute<{name:string;table:string}>(sql`SELECT seq.relname AS name,t.relname AS "table" FROM pg_class seq JOIN pg_depend d ON d.objid=seq.oid AND d.deptype IN('a','i') JOIN pg_class t ON t.oid=d.refobjid WHERE seq.relkind='S'`);for(const sequence of sequences)if(plan.tables[sequence.table]?.includes('INSERT'))await f.exec(`GRANT USAGE ON SEQUENCE public.${ident(sequence.name)} TO ${ident(role)}`);
  for(const signature of [...CUSTOMER_WORK_LOCK_FUNCTIONS,...CUSTOMER_FINANCIAL_FUNCTIONS,'checkout_lock_pricing_v1()'])await f.exec(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${ident(role)}`);
  await runInvoiceEvidence(f.db,role);await runRefundOrderSplit(f.db,role);
  const target=new URL(base.href);target.pathname='/'+origin.database;target.username=role;target.password=password;const connect=()=>postgres(target.href,{max:1,prepare:false,connect_timeout:5,idle_timeout:0,max_lifetime:0,connection:{options:'-c search_path=public,pg_temp -c statement_timeout=10000 -c lock_timeout=3000'}});client=connect();const verify=async(c:ReturnType<typeof postgres>)=>{const [x]=await c`SELECT current_database() AS database,current_user AS role,session_user AS session,pg_backend_pid() AS pid,(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated,has_column_privilege(current_user,'store_service','customer','UPDATE') AS forge_customer,has_table_privilege(current_user,'customer_financial_operation_request','UPDATE,DELETE,TRUNCATE') AS forge_receipt`;if(x.database!==origin.database||x.role!==role||x.session!==role||x.elevated!==false||x.forge_customer!==false||x.forge_receipt!==false)throw Error('Customer financial runtime identity/authority unreviewed');return Number(x.pid);};await verify(client);
  const db=drizzle(client) as unknown as DbClient,actor=(uid=101):CustomerWorkActor=>({uid,auth_version:md5('owned-financial-password'),expires_at:Math.floor(Date.now()/1000)+3600});
  const env={...f.env,APP_KEY:'owned-customer-financial-key',ORDER_QUEUE:{sendBatch:async()=>{}},UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:''} as unknown as Env;
  const pricing=await auditCheckoutPricingLockRuntime(db,'public','customer-work');console.log('CUSTOMER_FINANCIAL_PRICING_RUNTIME '+JSON.stringify(pricing));if(!pricing.ready)throw Error('Actual ordinary customer pricing runtime was not commissioned: '+JSON.stringify(pricing));
  const guarded=['store_order_purchase_origin','store_order_refund_split','store_order_fulfillment_branch','store_order_invoice','store_order_invoice_allocation','store_order_invoice_evidence'];
  const reset=async()=>{for(const table of [schema.storeSeckill,schema.storeBargain,schema.storeCombination,schema.storeIntegral,schema.storeBargainUser,schema.storePink,schema.storeDiscounts])await f.db.delete(table);await f.db.delete(schema.storeProductAttrValue).where(sql`${schema.storeProductAttrValue.type}<>0`);await f.db.transaction(async maintenance=>{for(const name of guarded)await maintenance.execute(sql.raw(`ALTER TABLE public.${ident(name)} DISABLE TRIGGER USER`));for(const name of ['customer_financial_operation_request',...guarded,'store_order_refund_payment','store_order_refund','store_order_status','store_order_outbox','user_bill','user_brokerage','store_product_virtual','store_order_product_coupon_reward','luck_lottery_entitlement'])await maintenance.execute(sql.raw(`TRUNCATE public.${ident(name)} RESTART IDENTITY`));for(const name of guarded)await maintenance.execute(sql.raw(`ALTER TABLE public.${ident(name)} ENABLE TRIGGER USER`));});await f.db.delete(schema.storeOrderCartInfo);await f.db.delete(schema.storeOrder);await f.db.delete(schema.storeOrderEconomize);await f.db.delete(schema.storeOrderPromotions);await f.db.delete(schema.storeCart);await f.db.delete(schema.storeProductAttrValue).where(sql`${schema.storeProductAttrValue.id}=900`);await f.db.delete(schema.storeService);await f.db.insert(schema.user).values([101,102,103,104,105].map(uid=>({uid,account:`financial-actor-${uid}`,pwd:'owned-financial-password',status:1}))).onConflictDoNothing();await f.db.update(schema.user).set({nowMoney:'100.00',integral:100,payCount:0,status:1,isDel:0,deleteTime:null}).where(sql`${schema.user.uid} IN(11,101,102,103,104,105)`);await f.db.update(schema.user).set({pwd:'owned-financial-password'}).where(sql`${schema.user.uid} IN(101,102,103,104,105)`);await f.db.insert(schema.storeService).values([{id:1,uid:101,customer:1,accountStatus:1,status:0},{id:2,uid:102,customer:0,accountStatus:1,status:1}]);await f.db.insert(schema.systemStoreStaff).values([{id:901,uid:103,storeId:1,status:1,isManager:1,orderStatus:1},{id:902,uid:104,storeId:1,status:1,verifyStatus:1}]).onConflictDoNothing();await f.db.insert(schema.deliveryService).values({id:901,uid:105,type:0,relationId:0,status:1}).onConflictDoNothing();await f.db.update(schema.storeProduct).set({stock:10,sales:2,productType:0,isPresaleProduct:0}).where(sql`${schema.storeProduct.id}=70`);await f.db.update(schema.storeProductAttrValue).set({stock:10,sales:2,isRetired:0,price:'5.00'}).where(sql`${schema.storeProductAttrValue.productId}=70 AND ${schema.storeProductAttrValue.type}=0`);
   for(const name of['offline_pay_status','balance_func_status','yue_pay_status']){await f.db.delete(schema.systemConfig).where(sql`${schema.systemConfig.menuName}=${name}`);await f.db.insert(schema.systemConfig).values({menuName:name,value:'1'});}await f.db.delete(schema.systemConfig).where(sql`${schema.systemConfig.menuName}='refund_time_available'`);await f.db.insert(schema.systemConfig).values({menuName:'refund_time_available',value:'0'});
   for(let id=1;id<=3;id++){await f.db.insert(schema.storeOrder).values({id,orderId:'customer-financial-'+id,unique:'owned-financial-order-'+id,uid:11,paid:1,status:0,payType:'yue',totalNum:2,totalPrice:'10.00',payPrice:'10.00',addTime:Math.floor(Date.now()/1000)});await f.db.insert(schema.storeOrderCartInfo).values({id,oid:id,uid:11,cartId:String(500+id),unique:'owned-financial-cart-'+id,productId:70,skuUnique:'qared001',cartNum:2,writeTimes:2,writeSurplusTimes:2,surplusNum:2,splitSurplusNum:2,isSupportRefund:1,cartInfo:JSON.stringify({id:String(500+id),cart_num:2,financial_version:'checkout-line-finance-v1',product:{storeName:'实际财务商品',image:'/api/qa/image.svg',giveIntegral:'0.00'},sku:{id:1,price:'5.00',suk:'Red',write_times:1},sum_price:'5.00',sum_true_price:'10.00',costPrice:'0.00',promotions_true_price:'0.00',raw_postage_price:'0.00',gain_integral:'0',integral:0,coupon_price:'0.00',integral_price:'0.00',postage_price:'0.00',use_integral:'0',one_brokerage:'0.00',two_brokerage:'0.00',first_order_price:'0.00',division_staff_brokerage:'0.00',division_agent_brokerage:'0.00',division_brokerage:'0.00'})});}await f.exec("SELECT setval(pg_get_serial_sequence('store_order','id'),100,true),setval(pg_get_serial_sequence('store_order_cart_info','id'),100,true)");};
  // New purchase positives use actual checkout and money transactions. Legacy
  // paid seed roots above remain without origin; this helper never backfills them.
  let realPurchaseIndexes=false;
  const realPurchase=async(quantity=2,presale=false,consumePaid=true)=>{
   if(!Number.isSafeInteger(quantity)||quantity<1||quantity>3)throw Error('Invalid owned real-purchase quantity');
   if(!realPurchaseIndexes){for(const statement of await migration.generateMigration(migration.generateDrizzleJson({}),migration.generateDrizzleJson({storeOrderEconomize:schema.storeOrderEconomize,paymentReconciliationCase:schema.paymentReconciliationCase})))if(/^CREATE (?:UNIQUE )?INDEX/.test(statement.trim()))await f.exec(statement);realPurchaseIndexes=true;}
   await f.setConfig({...Object.fromEntries(Object.keys(f.config).map(key=>[key,'0'])),store_func_status:'1',store_self_mention:'1'});
   const endsAt=presale?Math.floor(Date.now()/1000)+30:0;
   await f.db.update(schema.storeProduct).set({type:0,relationId:0,productType:presale?1:0,isPresaleProduct:presale?1:0,
    presaleStartTime:presale?Math.floor(Date.now()/1000)-3600:0,presaleEndTime:endsAt,presaleDay:7,
    isLimit:0,isVip:0,isVipProduct:0,isSupportRefund:1,price:'5.00',giveIntegral:'0.00',freight:2}).where(sql`${schema.storeProduct.id}=70`);
   await f.db.update(schema.storeProductAttrValue).set({price:'5.00',vipPrice:'5.00',diskInfo:''}).where(sql`${schema.storeProductAttrValue.id}=1`);
   const skuUnique=presale?'qafinpr1':'qared001';
   if(presale){const [baseSku]=await f.db.select().from(schema.storeProductAttrValue).where(sql`${schema.storeProductAttrValue.id}=1`);
    await f.db.insert(schema.storeProductAttrValue).values({...baseSku,id:900,unique:skuUnique,stock:10,sales:0});}
   const [cart]=await f.db.insert(schema.storeCart).values({uid:11,type:presale?6:0,productId:70,productType:presale?1:0,
    productAttrUnique:skuUnique,cartNum:quantity,isNew:1,status:1}).returning();
   const virtual=presale?await f.db.insert(schema.storeProductVirtual).values(Array.from({length:quantity},()=>({productId:70,
    attrUnique:skuUnique,cardNo:'OWNED-REAL-'+crypto.randomUUID(),cardPwd:'OWNED-REAL-SECRET-'+crypto.randomUUID()}))).returning({id:schema.storeProductVirtual.id}):[];
   const maintenance=createContainerFromDb(f.db),key=crypto.randomUUID().replaceAll('-','');
   const created=await StoreOrderCreateService.createWithRuntime(maintenance,{CONFIG_KV:env.CONFIG_KV,requirePurchaseOrigin:true,
    nextOrderId:async()=> key},{uid:11,key,cartIds:[cart.id],type:presale?6:0,
    addressId:11,shippingType:1,useIntegral:false,userIp:'127.0.0.1'});
   const [unpaid]=await f.db.select().from(schema.storeOrder).where(sql`${schema.storeOrder.orderId}=${created.orderId}`);
   if(!unpaid||unpaid.paid!==0||unpaid.totalNum!==quantity||unpaid.payPrice!==(quantity*5).toFixed(2))throw Error('Real checkout did not preserve its unpaid financial quantity');
   const origin=await withTx(maintenance,tx=>readPurchaseOriginEvidence(tx,{orderId:unpaid.id,buyerId:11}));
   if(!origin||origin.totalNum!==quantity||origin.lines.length!==1||origin.lines[0].cartId!==String(cart.id))throw Error('Core checkout did not persist its actual origin');
   const payment=await applyStoreOrderBalancePayment(maintenance,{uid:11,orderId:created.orderId});
   if(payment.outcome!=='paid'||!payment.outbox)throw Error('Actual balance payment did not produce its original paid outbox');
   const consumer=new OrderOutboxService(createContainerFromDb(db),env),message={action:'processOrderPaidOutbox' as const,
    outboxId:payment.outbox.id,eventKey:payment.outbox.eventKey};
   if(consumePaid&&await consumer.processMessage(message)!=='completed')throw Error('Original paid outbox did not complete');
   const [order]=await f.db.select().from(schema.storeOrder).where(sql`${schema.storeOrder.id}=${unpaid.id}`),
    [line]=await f.db.select().from(schema.storeOrderCartInfo).where(sql`${schema.storeOrderCartInfo.oid}=${unpaid.id}`);
   if(!order||order.paid!==1||order.payType!=='yue'||!line)throw Error('Actual payment/readback is inconsistent');
    const [paidEvent]=await db.select().from(schema.storeOrderOutbox).where(sql`${schema.storeOrderOutbox.id}=${message.outboxId}`);
    const payload=paidEvent?.payload as {orderId?:unknown;orderNo?:unknown}|undefined;
    if(!paidEvent||paidEvent.eventKey!==message.eventKey||paidEvent.eventType!=='order.paid'||paidEvent.aggregateId!==order.id
      ||!payload||Object.keys(payload).length!==2||payload.orderId!==order.id||payload.orderNo!==order.orderId
      ||paidEvent.status!==(consumePaid?'COMPLETED':'PENDING')||order.supplierAllocationStatus!==(consumePaid?2:0))
     throw Error('Actual original paid event/allocation phase was not preserved');
    console.log('CUSTOMER_FINANCIAL_REAL_PAID_PHASE '+JSON.stringify({order_id:order.id,order_type:order.type,
     paid:order.paid,supplier_allocation_status:order.supplierAllocationStatus,outbox_id:paidEvent.id,outbox_status:paidEvent.status}));
    return{order,line,origin,payment,consumer,message,paidEvent,endsAt,virtualIds:virtual.map(x=>x.id)};
  };
  await reset();return{...f,realPurchase,maintenanceDb:f.db,close,reset,db,role,actor,env,container:createContainerFromDb(db),service:()=>new CustomerWorkFinancialService(createContainerFromDb(db),env),withPeer:async<T>(callback:(peer:DbClient,pid:number)=>Promise<T>)=>{const peer=connect();try{const pid=await verify(peer);return await callback(drizzle(peer) as unknown as DbClient,pid);}finally{await peer.end({timeout:5});}},tables};
 }catch(error){await close();throw error;}
}
