/** Owned historical review snapshots, real App identities and independent
 * restricted LOGINs. No purchase, rating creation or external provider is faked. */
import {SQL,sql} from 'drizzle-orm';
import {getTableConfig,PgDialect,type PgTable} from 'drizzle-orm/pg-core';
import {createContainerFromDb,type Container} from '@/lib/di';
import type {Env} from '@/env';
import {storeProduct,storeProductAttrValue,storeProductReply,storeProductReplyComment,supplierExtract,supplierFlowingWater,systemAdmin,systemMenus,systemRole,systemSupplier} from '@/models/schema';
import {createToken,md5} from '@/utils/jwt';
import {sequenceRunnerDatabase,type SequenceRunnerPeer} from './kefuSequenceRunnerDatabase';
export const supplierProductReplyPassword='owned-supplier-product-reply-password';
export const supplierProductReplyActor={id:21,supplierId:7,authVersion:md5(supplierProductReplyPassword),expiresAt:2147483647};
export type SupplierProductReplyRuntime=SequenceRunnerPeer&{role:string;connectionString:string;container:Container};
export async function supplierProductReplyFixture(){
 if(!process.env.TEST_FINANCE_POSTGRES_URL)throw Error('Supplier review fixture requires owned local PG16');
 const f=await sequenceRunnerDatabase();
 try{
  if(f.format!=='pg16'||!f.withRuntimeRole)throw Error('Supplier review fixture requires independent PG16 LOGINs');
  const readTables=[systemAdmin,systemSupplier,systemRole,systemMenus,storeProduct,storeProductReply,storeProductReplyComment]as PgTable[];
  const tables=[...readTables,storeProductAttrValue,supplierFlowingWater,supplierExtract],dialect=new PgDialect();
  for(const table of tables){const definition=getTableConfig(table),columns=definition.columns.map(column=>{
   const initial=column.default,defaultSql=initial===undefined?'':` default ${initial instanceof SQL?dialect.sqlToQuery(initial).sql:dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
   return `"${column.name}" ${column.getSQLType()}${defaultSql}${column.notNull?' not null':''}${column.primary?' primary key':''}`;
  });await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);}
  await f.db.insert(systemSupplier).values([{id:7,adminId:99,supplierName:'本机评价供应商甲'},{id:8,adminId:199,supplierName:'本机评价供应商乙'}]);
  await f.db.insert(systemRole).values([{id:21,type:4,relationId:7,rules:'supplier.product.view,supplier.product.manage'},
   {id:22,type:4,relationId:7,rules:'supplier.product.view'},{id:23,type:4,relationId:7,rules:'supplier.order.view'},
   {id:31,type:4,relationId:8,rules:'supplier.product.view,supplier.product.manage'}]);
  await f.db.insert(systemAdmin).values([21,22,23,31].map(id=>({id,adminType:4,relationId:id===31?8:7,account:'owned-product-reply-'+id,
   pwd:supplierProductReplyPassword,level:1,roles:String(id),status:1,isDel:0})));
  await f.db.insert(systemMenus).values([{id:401,type:4,authType:2,access:1,isDel:0,methods:'GET',apiUrl:'product/reply'},
   {id:402,type:4,authType:2,access:1,isDel:0,methods:'PUT',apiUrl:'product/reply/set_reply/<id>'}]);
  await f.db.insert(storeProduct).values([{id:80,type:2,relationId:7,storeName:'本机商品甲',keyword:'甲特定词',image:'/owned-media/product80.png',price:'19.99',stock:12,star:'4.0',isShow:1,isDel:0},
   {id:81,type:2,relationId:7,storeName:'本机商品乙',image:'/owned-media/product81.png',price:'25.00',stock:7,star:'5.0',isShow:1,isDel:0},
   {id:90,type:2,relationId:8,storeName:'别店商品',price:'9.00',stock:20},{id:91,type:0,relationId:7,storeName:'平台商品不能借归属'}]);
  const day=1791158400;
  await f.db.insert(storeProductReply).values([
   {id:601,type:2,relationId:7,productId:80,uid:101,nickname:'本机客户甲',comment:'商品甲原始评价',sku:'蓝',productScore:5,serviceScore:4,deliveryScore:3,logisticsScore:3,pics:'["/owned-media/review601.png"]',addTime:day+300},
   {id:602,type:2,relationId:7,productId:81,uid:102,nickname:'本机客户乙',comment:'商品乙已有回复',isReply:1,addTime:day+200},
   {id:603,type:2,relationId:7,productId:80,uid:103,nickname:'本机客户丙',comment:'商品甲第二条评价',productScore:3,serviceScore:3,deliveryScore:3,logisticsScore:3,addTime:day+100},
   {id:604,type:2,relationId:8,productId:90,uid:104,nickname:'别店客户',comment:'别店原评价',addTime:day},
   {id:605,type:2,relationId:7,productId:90,uid:105,comment:'评价自身甲但商品属乙',addTime:day},
   {id:606,type:2,relationId:8,productId:80,uid:106,comment:'评价乙但商品甲',addTime:day},
   {id:607,type:2,relationId:7,productId:80,uid:107,comment:'已删评价',isDel:1,addTime:day},
   {id:608,type:2,relationId:7,productId:91,uid:108,comment:'错误平台商品类型',addTime:day},
   {id:609,type:1,relationId:7,productId:80,uid:109,comment:'错误评价所有者类型',addTime:day},
  ]);
  await f.db.insert(storeProductReplyComment).values([
   {id:702,type:2,relationId:7,replyId:602,uid:0,pid:0,content:'本店原有官方回复',addTime:day+200,updateTime:day+200},
   {id:710,type:0,relationId:0,replyId:601,content:'平台回复不能借用',addTime:day},
   {id:711,type:2,relationId:8,replyId:601,content:'其他供应商回复不能借用',addTime:day},
   {id:712,type:2,relationId:7,replyId:601,uid:101,content:'用户跟评不能借用',addTime:day},
  ]);
  await f.db.insert(storeProductAttrValue).values({id:180,productId:80,unique:'ownrev80',suk:'蓝',stock:12,price:'19.99'});
  await f.db.insert(supplierFlowingWater).values({id:1,supplierId:7,orderId:'OWNED-UNCHANGED-FLOW',pm:1,number:'1000.00',status:1,type:1});
  await f.db.insert(supplierExtract).values({id:1,supplierId:7,extractType:'bank',bankCode:'00001111',bankAddress:'本机银行',extractPrice:'10.00',balance:'990.00',status:0});
  await f.exec("SELECT setval(pg_get_serial_sequence('public.store_product_reply_comment','id'),1000,false)");
  const withReader=<T>(work:(runtime:SupplierProductReplyRuntime)=>Promise<T>)=>f.withRuntimeRole!(async peer=>{
   await f.exec(`GRANT SELECT ON ${readTables.map(table=>'public."'+getTableConfig(table).name+'"').join(',')} TO "${peer.role}"`);
   return work({...peer,container:createContainerFromDb(peer.db)});
  });
  const withWriter=<T>(work:(runtime:SupplierProductReplyRuntime)=>Promise<T>)=>withReader(async runtime=>{
   await f.exec(`GRANT UPDATE(id) ON public.system_admin,public.system_supplier,public.system_role,public.system_menus,public.store_product TO "${runtime.role}";
    GRANT UPDATE(is_reply) ON public.store_product_reply TO "${runtime.role}";
    GRANT INSERT ON public.store_product_reply_comment TO "${runtime.role}";
    GRANT UPDATE(content,update_time) ON public.store_product_reply_comment TO "${runtime.role}";
    GRANT USAGE ON SEQUENCE public.store_product_reply_comment_id_seq TO "${runtime.role}"`);
   return work(runtime);
  });
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>{const name=getTableConfig(table).name;
   return[name,await f.exec(`SELECT to_jsonb(t) AS row FROM public."${name}" t ORDER BY to_jsonb(t)::text`)];})));
  const sequence=()=>f.exec('SELECT last_value,is_called FROM public.store_product_reply_comment_id_seq');
  const env={APP_KEY:'owned-supplier-product-reply-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:''}as Env;
  const token=async(id:number)=>(await createToken(id,'supplier',md5(supplierProductReplyPassword),env.APP_KEY)).token;
  const tokens={reader:await token(21),viewer:await token(22),denied:await token(23),other:await token(31)};
  return{...f,container:createContainerFromDb(f.db),withReader,withWriter,snapshot,sequence,env,tokens,
   ids:{product:80,secondProduct:81,foreignProduct:90,review:601,secondReview:602,anotherReview:603,foreignReview:604,firstNewComment:1000}};
 }catch(error){await f.close();throw error;}
}
