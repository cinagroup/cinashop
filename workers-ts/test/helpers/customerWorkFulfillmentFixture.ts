import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { SQL,sql } from 'drizzle-orm';
import { getTableConfig,PgDialect } from 'drizzle-orm/pg-core';
import type { DbClient } from '../../src/lib/di';
import { createContainerFromDb } from '../../src/lib/di';
import type { Env } from '../../src/env';
import { user,storeService,storeOrder,storeOrderCartInfo,systemStore,systemStoreStaff,systemSupplier,expressCompany,deliveryService,systemConfig,storeOrderStatus,storeOrderOutbox,storeOrderInvoice,storeOrderInvoiceAllocation,storeOrderInvoiceEvidence,supplierFlowingWater,cityArea } from '../../src/models/schema';
import { customerReadTables } from './customerWorkReadFixture';
import { sequenceRunnerDatabase,type SequenceRunnerPeer } from './kefuSequenceRunnerDatabase';
import { runCustomerWaybillActor } from '../../src/migrations/runCustomerWaybillActor';
import { runCustomerWorkOperation } from '../../src/migrations/runCustomerWorkOperation';
import { installCustomerWorkScopeLock } from '../../src/migrations/runCustomerWorkScopeLock';
import { installCustomerCityDelivery } from '../../src/migrations/customerCityDelivery';
import { customerWorkRuntimePrivilegePlan,CUSTOMER_WORK_LOCK_FUNCTIONS } from '../../src/migrations/customerWorkRuntimePrivilegePlan';
import { CustomerWorkFulfillmentService } from '../../src/services/customer-work/CustomerWorkFulfillmentService';
import { CustomerWorkOperationRequest } from '../../src/services/customer-work/CustomerWorkOperationRequest';
import type { CustomerWorkActor } from '../../src/services/customer-work/CustomerWorkScope';
import { md5 } from '../../src/utils/jwt';

const ident=(v:string)=>{if(!/^[a-z_][a-z_0-9]*$/.test(v))throw Error('Invalid owned fulfillment fixture identifier');return `"${v}"`;};
export const customerFulfillmentTables=[...customerReadTables.filter(t=>!['order_waybill_job','order_waybill_job_action','customer_city_delivery_job','customer_city_delivery_attempt','customer_city_delivery_binding'].includes(getTableConfig(t).name)),storeOrderStatus,storeOrderOutbox,storeOrderInvoice,storeOrderInvoiceAllocation,storeOrderInvoiceEvidence,supplierFlowingWater,cityArea];
export async function customerWorkFulfillmentFixture(){
 const f=await sequenceRunnerDatabase();if(f.format!=='pg16'||!f.withRuntimeRole){await f.close();throw Error('Fulfillment requires native PG16 independent LOGIN');}
 const ownerRole=`customer_scope_owner_${randomUUID().replaceAll('-','')}`;let ownerCreated=false;
 try{
  const dialect=new PgDialect();
  for(const table of customerFulfillmentTables){const d=getTableConfig(table),columns=d.columns.map(c=>{const initial=c.default,value=initial===undefined?'':` DEFAULT ${initial instanceof SQL?dialect.sqlToQuery(initial).sql:dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;return `${ident(c.name)} ${c.getSQLType()}${value}${c.notNull?' NOT NULL':''}${c.primary?' PRIMARY KEY':''}${c.isUnique?' UNIQUE':''}`;});await f.exec(`CREATE TABLE public.${ident(d.name)} (${columns.join(',')})`);}
  // Exact authored protocols and indexes, never column-only substitute tables.
  await f.exec(readFileSync(new URL('../../migrations/0091_electronic_waybill_outbox.sql',import.meta.url),'utf8'));
  await runCustomerWaybillActor(f.db);await runCustomerWorkOperation(f.db);
  await installCustomerCityDelivery(f.db,{maintenance:true});
  await f.exec('CREATE UNIQUE INDEX customer_notice_event_key ON store_order_outbox(event_key)');
  await f.exec(`CREATE ROLE ${ident(ownerRole)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);ownerCreated=true;
  await installCustomerWorkScopeLock(f.db,ownerRole);
  const tableNames=[...customerFulfillmentTables.map(t=>getTableConfig(t).name),'order_waybill_job','order_waybill_job_action','customer_work_operation_request','customer_city_delivery_job','customer_city_delivery_attempt','customer_city_delivery_binding'];
  const actor=(uid=101):CustomerWorkActor=>({uid,auth_version:md5('owned-customer-password'),expires_at:Math.floor(Date.now()/1000)+3600});
  const messages:unknown[]=[];
  const env={APP_KEY:'owned-customer-fulfillment-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',CRMEB_ONEPASS_ACCESS_KEY:'owned-onepass-access',CRMEB_ONEPASS_SECRET_KEY:'owned-onepass-secret',ORDER_QUEUE:{sendBatch:async(batch:unknown[])=>{messages.push(...batch);}},CONFIG_KV:{get:async()=>null,put:async()=>{},delete:async()=>{}}} as unknown as Env;
  const order=(id:number,values:Partial<typeof storeOrder.$inferInsert>={})=>({id,orderId:`customer-order-${id}`,unique:`customer-unique-${id}`,uid:201,realName:'实际收件人',userPhone:'13900000201',userAddress:'实际收件地址',paid:1,status:0,shippingType:1,totalNum:3,totalPrice:'30.00',payPrice:'30.00',payType:'yue',refundStatus:0,addTime:Math.floor(Date.now()/1000),...values});
  const cart=(id:number,values:Partial<typeof storeOrderCartInfo.$inferInsert>={})=>({id,oid:id,uid:201,cartId:`cart-${id}`,unique:`cart-unique-${id}`,productId:1,productType:0,cartNum:3,surplusNum:3,splitSurplusNum:3,settlePrice:'2.00',cartInfo:JSON.stringify({id:`cart-${id}`,cart_num:3,productInfo:{id:1,store_name:'实际商品快照',price:'10.00',attrInfo:{suk:'真实规格',price:'10.00'}},truePrice:'10.00',sum_true_price:'30.00'}),...values});
  const reset=async(extraOwnedTables:readonly string[]=[])=>{messages.length=0;for(const name of extraOwnedTables)ident(name);await f.exec(`TRUNCATE ${[...new Set([...tableNames,...extraOwnedTables])].map(n=>`public.${ident(n)}`).join(',')} RESTART IDENTITY`);
   await f.db.insert(user).values([...Array.from({length:9},(_,i)=>({uid:101+i,account:`work-actor-${i}`,pwd:'owned-customer-password',nickname:`手机经营员${i}`,phone:`1390000010${i}`,status:1,isDel:0})),{uid:201,account:'actual-customer',pwd:'PRIVATE WALLET PASSWORD',nowMoney:'202.00',nickname:'实际客户',phone:'13900000201'}]);
   await f.db.insert(storeService).values([{id:1,uid:101,account:'mobile-work-only',customer:1,accountStatus:1,status:0},{id:2,uid:102,account:'chat-only',customer:0,accountStatus:1,status:1}]);
   await f.db.insert(systemStore).values({id:77,name:'真实门店',isStore:1,isShow:1});await f.db.insert(systemSupplier).values({id:88,supplierName:'真实供应商',isShow:1,isDel:0});
   await f.db.insert(systemStoreStaff).values([{id:1,uid:103,storeId:77,status:1,isManager:1,orderStatus:1},{id:2,uid:104,storeId:77,status:1,verifyStatus:1}]);
   await f.db.insert(deliveryService).values({id:1,uid:105,nickname:'实际平台配送员',phone:'13900000105',status:1,type:0,relationId:0});
   await f.db.insert(expressCompany).values({id:1,name:'实际快递',code:'LOCAL',isShow:1,status:1});
   await f.db.insert(systemConfig).values([{id:1,menuName:'config_export_open',value:'1'},{id:2,menuName:'config_export_id',value:'1'},{id:3,menuName:'config_export_temp_id',value:'owned-template'},{id:4,menuName:'config_export_to_name',value:'实际发件人'},{id:5,menuName:'config_export_to_tel',value:'13900000999'},{id:6,menuName:'config_export_to_address',value:'实际发件地址'}]);
   await f.db.insert(storeOrder).values(order(1));await f.db.insert(storeOrderCartInfo).values(cart(1));
   await f.exec("SELECT setval(pg_get_serial_sequence('store_order','id'),100,true),setval(pg_get_serial_sequence('store_order_cart_info','id'),100,true)");
  };
  const app=async<T>(callback:(db:DbClient,role:string,peer:SequenceRunnerPeer)=>Promise<T>)=>f.withRuntimeRole!(async peer=>{
   const plan=customerWorkRuntimePrivilegePlan();
   for(const name of tableNames){const privileges=plan.tables[name];if(!privileges)throw Error(`No fixed runtime plan for ${name}`);if(privileges.length)await f.exec(`GRANT ${privileges.join(',')} ON public.${ident(name)} TO ${ident(peer.role)}`);const columns=plan.updateColumns[name];if(columns?.length)await f.exec(`GRANT UPDATE(${columns.map(ident).join(',')}) ON public.${ident(name)} TO ${ident(peer.role)}`);}
   const sequences=await f.exec("SELECT seq.relname AS name,t.relname AS table_name FROM pg_class seq JOIN pg_depend d ON d.objid=seq.oid AND d.deptype IN('a','i') JOIN pg_class t ON t.oid=d.refobjid WHERE seq.relkind='S'");
   for(const s of sequences)if(plan.tables[String(s.table_name)]?.includes('INSERT'))await f.exec(`GRANT USAGE ON SEQUENCE public.${ident(String(s.name))} TO ${ident(peer.role)}`);
   for(const signature of CUSTOMER_WORK_LOCK_FUNCTIONS)await f.exec(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${ident(peer.role)}`);
   const [identity]=await peer.exec("SELECT current_user AS role,session_user AS session,(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated,has_column_privilege(current_user,'store_service','customer','UPDATE') AS forge_role,has_table_privilege(current_user,'delivery_service','UPDATE') AS forge_courier,has_table_privilege(current_user,'express_company','UPDATE') AS forge_carrier,has_table_privilege(current_user,'customer_work_operation_request','UPDATE') AS rewrite_receipt");
   if(identity.role!==peer.role||identity.session!==peer.role||identity.elevated!==false||identity.forge_role!==false||identity.forge_courier!==false||identity.forge_carrier!==false||identity.rewrite_receipt!==false)throw Error('Customer fixture must use exact independent non-forging LOGIN');
   return callback(peer.db,peer.role,peer);
  });
  await reset();
  const close=async()=>{try{if(ownerCreated){await f.exec(`DROP OWNED BY ${ident(ownerRole)}; DROP ROLE ${ident(ownerRole)}`);ownerCreated=false;}}finally{await f.close();}};
  return{...f,close,reset,actor,order,cart,app,env,messages,tables:customerFulfillmentTables,tableNames,service:(db:DbClient)=>new CustomerWorkFulfillmentService(createContainerFromDb(db),env),ledger:(db:DbClient)=>new CustomerWorkOperationRequest(createContainerFromDb(db))};
 }catch(error){try{if(ownerCreated)await f.exec(`DROP OWNED BY ${ident(ownerRole)}; DROP ROLE ${ident(ownerRole)}`);}finally{await f.close();}throw error;}
}
