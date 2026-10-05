import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { eq, sql, SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb, withTx, type DbClient } from '../../src/lib/di';
import { cityArea, systemConfig, systemStore, systemSupplier, memberRight, systemUserLevel, userLevel, userBill, userBrokerage } from '../../src/models/schema';
import { customerWorkRuntimePrivilegePlan } from '../../src/migrations/customerWorkRuntimePrivilegePlan';
import { CustomerCityDeliveryService, acquireCustomerCityAdmissionFence, type CustomerCityAdmission, type CustomerCityIdentity } from '../../src/services/customer-work/CustomerCityDeliveryService';
import type { CustomerCityEnv } from '../../src/services/delivery/CustomerCityDeliveryProvider';
import { readCustomerWorkScope } from '../../src/services/customer-work/CustomerWorkScope';
import { lockOrderSettlement } from '../../src/services/order/OrderBrokerageService';
import { customerWorkFulfillmentFixture } from './customerWorkFulfillmentFixture';

const callbackTables=['city_delivery_callback_event','city_delivery_callback_outbox','city_delivery_callback_watermark','city_delivery_reconciliation_case'];
const notificationTables=['order_notification_delivery'];
const receiptTables=[memberRight,systemUserLevel,userLevel,userBill,userBrokerage];
const identifier=(v:string)=>{if(!/^[a-z_][a-z0-9_]*$/.test(v))throw Error('Invalid owned city fixture identifier');return `"${v}"`;};
/** Real authored maintenance protocols and ordinary LOGIN. Provider fetches are
 * controlled by the test; this fixture never adopts public SDK sample secrets. */
export async function customerCityDeliveryFixture(){
 const base=await customerWorkFulfillmentFixture();
 try{
  await base.exec(readFileSync(new NodeURL('../../migrations/0124_city_delivery_callback_pipeline.sql',import.meta.url),'utf8'));
  // Run the original authored delivery ledger and its subject upgrade; unrelated
  // channel-source indexes and withdrawal tables are outside this city fixture.
  const noticeDDL=readFileSync(new NodeURL('../../migrations/0085_external_notification_delivery.sql',import.meta.url),'utf8');
  await base.exec(noticeDDL.slice(0,noticeDDL.indexOf('-- Restore the source lookup indexes')));
  const noticeUpgrade=readFileSync(new NodeURL('../../migrations/0131_withdrawal_effects.sql',import.meta.url),'utf8');
  await base.exec(noticeUpgrade.slice(noticeUpgrade.indexOf('ALTER TABLE "order_notification_delivery"'),noticeUpgrade.indexOf('ALTER TABLE "store_order_outbox"')));
  const dialect=new PgDialect();
  for(const table of receiptTables){const definition=getTableConfig(table),columns=definition.columns.map(c=>{const value=c.default===undefined?'':` DEFAULT ${c.default instanceof SQL?dialect.sqlToQuery(c.default).sql:dialect.sqlToQuery(sql`${c.default}`.inlineParams()).sql}`;return `${identifier(c.name)} ${c.getSQLType()}${value}${c.notNull?' NOT NULL':''}${c.primary?' PRIMARY KEY':''}${c.isUnique?' UNIQUE':''}`;});await base.exec(`CREATE TABLE public.${identifier(definition.name)} (${columns.join(',')})`);}
  const env:CustomerCityEnv={...base.env,DADA_APP_KEY:'owned-dada-key',DADA_APP_SECRET:'owned-dada-secret',DADA_SOURCE_ID:'owned-dada-source',DADA_CLIENT_ID:'owned-dada-client',DADA_CALLBACK_TOKEN:'owned_callback_dada_token_0123456789',UU_APP_ID:'owned-uu-app',UU_APP_KEY:'owned-uu-key',UU_OPEN_ID:'owned-uu-open-id',UU_CALLBACK_TOKEN:'owned_callback_uu_token_012345678901',UU_API_TIMESTAMP_UNIT:'seconds',CUSTOMER_CITY_CALLBACK_ORIGIN:'https://city-fixture.example.com'};
  const city=(db:DbClient)=>new CustomerCityDeliveryService(createContainerFromDb(db),env);
  const identity=(orderId=1,storeId=0,supplierId=0,rootOrderId=orderId,requestedOrderId=orderId):CustomerCityIdentity=>({requestedOrderId,rootOrderId,orderId,customerUid:201,storeId,supplierId});
  const reset=async()=>{
   delete env.CUSTOMER_CITY_UU_ORIGIN_BINDING_CONTRACT;
   await base.reset([...callbackTables,...notificationTables,...receiptTables.map(t=>getTableConfig(t).name)]);
   await base.db.insert(cityArea).values({id:2,name:'上海市'});
   await base.db.update(systemStore).set({city:2,phone:'13900000777',address:'上海市真实门店地址',detailedAddress:'上海市真实门店地址',cityShopId:'real-store-station-77'}).where(eq(systemStore.id,77));
   await base.db.update(systemSupplier).set({city:2,phone:'13900000888',address:'上海市真实供应商地址',detailedAddress:'上海市真实供应商地址',cityShopId:'real-supplier-station-88'}).where(eq(systemSupplier.id,88));
   await base.db.insert(systemConfig).values([{id:20,menuName:'city_delivery_status',value:'1'},{id:21,menuName:'dada_delivery_status',value:'1'},{id:22,menuName:'uu_delivery_status',value:'1'},{id:23,menuName:'refund_name',value:'真实平台发件人'},{id:24,menuName:'refund_address',value:'上海市真实平台地址'},{id:25,menuName:'refund_phone',value:'13900000999'}]);
  };
  const app=async<T>(callback:Parameters<typeof base.app<T>>[0])=>base.app(async(db,role,peer)=>{
   const plan=customerWorkRuntimePrivilegePlan();
   const extraNames=[...callbackTables,...notificationTables,...receiptTables.map(t=>getTableConfig(t).name)];
   for(const table of extraNames){const grants=plan.tables[table];if(!grants)throw Error('City fixture table absent from fixed runtime plan');if(grants.length)await base.exec(`GRANT ${grants.join(',')} ON public.${identifier(table)} TO ${identifier(role)}`);const columns=plan.updateColumns[table];if(columns?.length)await base.exec(`GRANT UPDATE(${columns.map(identifier).join(',')}) ON public.${identifier(table)} TO ${identifier(role)}`);}
   const sequences=await base.exec("SELECT seq.relname AS name,t.relname AS table_name FROM pg_class seq JOIN pg_depend d ON d.objid=seq.oid AND d.deptype IN('a','i') JOIN pg_class t ON t.oid=d.refobjid WHERE seq.relkind='S'");
   for(const s of sequences)if(extraNames.includes(String(s.table_name))&&plan.tables[String(s.table_name)]?.includes('INSERT'))await base.exec(`GRANT USAGE ON SEQUENCE public.${identifier(String(s.name))} TO ${identifier(role)}`);
   return callback(db,role,peer);
  });
  const admit=async(db:DbClient,key:string,selected:CustomerCityIdentity=identity(),overrides:Partial<CustomerCityAdmission>={})=>withTx(createContainerFromDb(db),async tx=>{
   await acquireCustomerCityAdmissionFence(tx);await lockOrderSettlement(tx,selected.rootOrderId);if(selected.orderId!==selected.rootOrderId)await lockOrderSettlement(tx,selected.orderId);
   const scope=(await readCustomerWorkScope(tx,101))!;
   return city(db).admitInTx(tx,{actor_uid:101,service_id:scope.service_id,scope_key:scope.scope_key,actor_auth_version:base.actor().auth_version,actor_expires_at:base.actor().expires_at,request_key:key,request_hash:'a'.repeat(64),identity:selected,payload:{station_type:1,cargo_weight:'2.50',delivery_remark:'真实配送备注'},...overrides});
  });
  await reset();return{...base,reset,app,env,city,identity,admit};
 }catch(error){await base.close();throw error;}
}
