import {randomUUID} from 'node:crypto';
import {SQL,sql} from 'drizzle-orm';
import {getTableConfig,PgDialect} from 'drizzle-orm/pg-core';
import {Hono} from 'hono';
import {createContainerFromDb,type DbClient} from '../../src/lib/di';
import type {AppVariables,Env} from '../../src/env';
import {user,storeService,deliveryService,expressCompany,storeProduct,storeProductAttrValue,storeProductRelation,storeProductCategory,storeProductLabel,legacyCategory,storeCart,storeProductStockRecord,systemStore,systemStoreStaff,systemSupplier,systemAttachment,storeProductVirtual,systemLog} from '../../src/models/schema';
import {sequenceRunnerDatabase,type SequenceRunnerPeer} from './kefuSequenceRunnerDatabase';
import {installCustomerWorkScopeLock} from '../../src/migrations/runCustomerWorkScopeLock';
import {CUSTOMER_WORK_LOCK_FUNCTIONS} from '../../src/migrations/customerWorkRuntimePrivilegePlan';
import {runCustomerProductOperation} from '../../src/migrations/runCustomerProductOperation';
import {installCustomerProductCatalogLock} from '../../src/migrations/runCustomerProductCatalogLock';
import {customerProductRuntimePrivilegePlan,CUSTOMER_PRODUCT_FUNCTIONS} from '../../src/migrations/customerProductRuntimePlan';
import {CustomerWorkProductReadService} from '../../src/services/customer-work/CustomerWorkProductReadService';
import {CustomerWorkProductOperationService} from '../../src/services/customer-work/CustomerWorkProductOperationService';
import type {CustomerWorkActor} from '../../src/services/customer-work/CustomerWorkScope';
import {authMiddleware} from '../../src/middleware/auth';
import * as Controller from '../../src/controllers/api/v1/CustomerWorkProductController';
import {md5} from '../../src/utils/jwt';

const ident=(name:string)=>{if(!/^[a-z_][a-z_0-9]*$/.test(name))throw Error('Invalid product fixture identifier');return`"${name}"`;};
export const customerProductTables=[user,storeService,deliveryService,expressCompany,storeProduct,storeProductAttrValue,storeProductRelation,storeProductCategory,storeProductLabel,legacyCategory,storeCart,storeProductStockRecord,systemStore,systemStoreStaff,systemSupplier,systemAttachment,storeProductVirtual,systemLog];
export async function customerWorkProductFixture(){
 const f=await sequenceRunnerDatabase();if(f.format!=='pg16'||!f.withRuntimeRole){await f.close();throw Error('Customer products require native PG16 independent LOGIN');}
 const owners=[`customer_product_scope_${randomUUID().replaceAll('-','')}`,`customer_product_taxonomy_${randomUUID().replaceAll('-','')}`],created:string[]=[];
 try{
  const dialect=new PgDialect();for(const table of customerProductTables){const d=getTableConfig(table),columns=d.columns.map(c=>{const initial=c.default,value=initial===undefined?'':` DEFAULT ${initial instanceof SQL?dialect.sqlToQuery(initial).sql:dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;return`${ident(c.name)} ${c.getSQLType()}${value}${c.notNull?' NOT NULL':''}${c.primary?' PRIMARY KEY':''}${c.isUnique?' UNIQUE':''}`;});await f.exec(`CREATE TABLE public.${ident(d.name)} (${columns.join(',')})`);}
  await runCustomerProductOperation(f.db);
  for(const owner of owners){await f.exec(`CREATE ROLE ${ident(owner)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);created.push(owner);}
  await installCustomerWorkScopeLock(f.db,owners[0]);await installCustomerProductCatalogLock(f.db,owners[1]);
  const tableNames=[...customerProductTables.map(t=>getTableConfig(t).name),'customer_product_operation_request'];
  const actor=(uid=101):CustomerWorkActor=>({uid,auth_version:md5('owned-customer-password'),expires_at:Math.floor(Date.now()/1000)+3600});
  const env={APP_KEY:'owned-customer-product-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',CONFIG_KV:{get:async()=>null,put:async()=>{},delete:async()=>{}}} as unknown as Env;
  const product=(id:number,values:Partial<typeof storeProduct.$inferInsert>={})=>({id,storeName:`真实商品${id}`,isVerify:1,isShow:1,price:'10.00',cost:'2.00',otPrice:'20.00',stock:999,sales:3,ficti:900,cateId:'10',storeLabelId:'20',...values});
  const sku=(id:number,productId:number,values:Partial<typeof storeProductAttrValue.$inferInsert>={})=>({id,productId,unique:`sku${String(id).padStart(5,'0')}`,suk:`实际规格${id}`,price:'10.00',cost:'2.00',otPrice:'20.00',stock:5,sumStock:12,sales:4,type:0,isRetired:0,...values});
  const reset=async()=>{
   await f.exec(`TRUNCATE ${tableNames.map(n=>`public.${ident(n)}`).join(',')} RESTART IDENTITY`);
   await f.db.insert(user).values(Array.from({length:12},(_,i)=>({uid:101+i,account:`product-actor-${i}`,pwd:'owned-customer-password',nickname:`经营用户${i}`,status:1,isDel:0})));
   await f.db.insert(storeService).values([{id:1,uid:101,account:'customer-chat-off',customer:1,accountStatus:1,status:0},{id:2,uid:102,account:'kefu-only',customer:0,accountStatus:1,status:1},{id:3,uid:106,account:'disabled-role',customer:1,accountStatus:0},{id:4,uid:107,account:'deleted-role',customer:1,isDel:1}]);
   await f.db.insert(systemStore).values({id:77,name:'真实门店',isShow:1});await f.db.insert(systemSupplier).values({id:88,supplierName:'真实供应商',isShow:1,isDel:0});
   await f.db.insert(systemStoreStaff).values([{id:1,uid:103,storeId:77,status:1,isManager:1,orderStatus:1},{id:2,uid:104,storeId:77,status:1,verifyStatus:1}]);await f.db.insert(deliveryService).values({id:1,uid:105,type:0,relationId:0,status:1});
   await f.db.insert(storeProductCategory).values([{id:10,pid:0,cateName:'平台父分类',isShow:1,type:0,relationId:0},{id:11,pid:10,cateName:'平台子分类',isShow:1,type:0,relationId:0},{id:12,pid:0,cateName:'他店分类',isShow:1,type:1,relationId:77},{id:13,pid:0,cateName:'隐藏分类',isShow:0,type:0,relationId:0}]);
   await f.db.insert(legacyCategory).values([{id:1,name:'平台标签组',group:2,type:0,relationId:0,isShow:1},{id:2,name:'供应商标签组',group:2,type:2,relationId:88,isShow:1}]);
   await f.db.insert(storeProductLabel).values([{id:20,labelCate:1,labelName:'平台标签',type:0,relationId:0,status:1,isShow:1},{id:21,labelCate:1,labelName:'他店标签',type:1,relationId:77,status:1,isShow:1},{id:22,labelCate:2,labelName:'错误组标签',type:0,relationId:0,status:1,isShow:1}]);
   await f.db.insert(storeProduct).values([product(1),product(2,{type:1,relationId:77,pid:1,specType:1,storeName:'门店副本',stock:7}),product(3,{type:2,relationId:88,storeName:'供应商商品',isShow:0}),product(4,{isPolices:1,stock:500}),product(5,{isSold:1,stock:0}),product(6,{isVerify:0}),product(7,{isDel:1})]);
   await f.db.insert(storeProductAttrValue).values([sku(1,1,{barCode:'BASE-BAR'}),sku(2,2,{stock:3}),sku(3,2,{stock:4,price:'15.00',cost:'3.00',otPrice:'25.00'}),sku(4,3),sku(5,4),sku(6,5,{stock:0}),sku(7,6),sku(8,7),sku(9,1,{type:2,stock:888,barCode:'ACTIVITY-BAR'}),sku(10,1,{isRetired:1,stock:777})]);
   await f.db.insert(storeProductRelation).values([{id:1,productId:1,relationId:10,type:1,status:1},{id:2,productId:1,relationId:20,type:3,status:1}]);
   await f.db.insert(storeCart).values([{id:1,uid:101,productId:1,productAttrUnique:'sku00001',cartNum:1,isPay:0,isDel:0,status:1},{id:2,uid:101,productId:1,productAttrUnique:'sku00001',cartNum:1,isPay:1,isDel:0,status:1}]);
   const sequences=await f.exec("SELECT c.relname AS table_name,a.attname AS column_name FROM pg_class seq JOIN pg_depend d ON d.objid=seq.oid AND d.deptype IN('a','i') JOIN pg_class c ON c.oid=d.refobjid JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=d.refobjsubid WHERE seq.relkind='S'");for(const row of sequences){const table=String(row.table_name),column=String(row.column_name);if(!tableNames.includes(table))throw Error('Unexpected product fixture sequence owner');await f.exec(`SELECT setval(pg_get_serial_sequence('public.${table}','${column}'),COALESCE((SELECT MAX(${ident(column)}) FROM public.${ident(table)}),1),EXISTS(SELECT 1 FROM public.${ident(table)}))`);}
  };
  const app=async<T>(callback:(db:DbClient,role:string,peer:SequenceRunnerPeer)=>Promise<T>)=>f.withRuntimeRole!(async peer=>{
   const plan=customerProductRuntimePrivilegePlan();for(const name of tableNames){const privileges=plan.tables[name];if(!privileges)throw Error(`Missing fixed customer product privileges for ${name}`);if(privileges.length)await f.exec(`GRANT ${privileges.join(',')} ON public.${ident(name)} TO ${ident(peer.role)}`);const columns=plan.updateColumns[name];if(columns?.length)await f.exec(`GRANT UPDATE(${columns.map(ident).join(',')}) ON public.${ident(name)} TO ${ident(peer.role)}`);}
   const sequences=await f.exec("SELECT seq.relname AS name,t.relname AS table_name FROM pg_class seq JOIN pg_depend d ON d.objid=seq.oid AND d.deptype IN('a','i') JOIN pg_class t ON t.oid=d.refobjid WHERE seq.relkind='S'");for(const s of sequences)if(plan.tables[String(s.table_name)]?.includes('INSERT'))await f.exec(`GRANT USAGE ON SEQUENCE public.${ident(String(s.name))} TO ${ident(peer.role)}`);
   for(const signature of[...CUSTOMER_WORK_LOCK_FUNCTIONS,...CUSTOMER_PRODUCT_FUNCTIONS])await f.exec(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${ident(peer.role)}`);
   const[row]=await peer.exec("SELECT current_user AS role,session_user AS session,(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated,has_table_privilege(current_user,'store_product_category','INSERT,UPDATE,DELETE') AS taxonomy_dml,has_table_privilege(current_user,'customer_product_operation_request','UPDATE,DELETE,TRUNCATE') AS ledger_dml,has_column_privilege(current_user,'store_service','customer','UPDATE') AS role_dml");if(row.role!==peer.role||row.session!==peer.role||row.elevated!==false||row.taxonomy_dml!==false||row.ledger_dml!==false||row.role_dml!==false)throw Error('Product fixture must use independent non-forging LOGIN');return callback(peer.db,peer.role,peer);
  });
  const taxonomyWriter=async<T>(callback:(peer:SequenceRunnerPeer&{role:string})=>Promise<T>)=>f.withRuntimeRole!(async peer=>{for(const name of['store_product_category','store_product_label','category'])await f.exec(`GRANT SELECT,INSERT,UPDATE,DELETE ON public.${ident(name)} TO ${ident(peer.role)}`);return callback(peer);});
  const reader=(db:DbClient)=>new CustomerWorkProductReadService(createContainerFromDb(db),env),writer=(db:DbClient)=>new CustomerWorkProductOperationService(createContainerFromDb(db));
  const http=(db:DbClient)=>{const h=new Hono<{Bindings:Env;Variables:AppVariables}>();h.use('*',async(c,next)=>{c.set('container',createContainerFromDb(db));await next();});h.use('*',authMiddleware({force:true}));h.onError((error,c)=>c.json({status:400,msg:error.message,data:null},400));h.get('/products',Controller.productList);h.get('/products/categories',Controller.productCategories);h.get('/products/labels',Controller.productLabels);h.get('/products/operations/:key',Controller.productOperationOutcome);h.post('/products/operations/:key/abandon',Controller.abandonProductOperation);h.get('/products/:id/skus',Controller.productSkus);h.post('/products/show',Controller.setProductShow);h.post('/products/batch',Controller.batchProducts);h.post('/products/:id/skus',Controller.updateProductSkus);return h;};
  await reset();return{...f,reset,actor,env,product,sku,app,taxonomyWriter,reader,writer,http,tableNames,close:async()=>{try{for(const owner of created.reverse())await f.exec(`DROP OWNED BY ${ident(owner)}; DROP ROLE ${ident(owner)}`);}finally{await f.close();}}};
 }catch(error){try{for(const owner of created.reverse())await f.exec(`DROP OWNED BY ${ident(owner)}; DROP ROLE ${ident(owner)}`);}finally{await f.close();}throw error;}
}
