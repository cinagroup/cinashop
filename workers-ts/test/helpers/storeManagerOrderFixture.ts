import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createContainerFromDb,type DbClient } from '../../src/lib/di';
import { systemStoreStaff,systemStore,systemUserLevel,user,userAddress,storeProduct,storeProductLog,storeOrder,storeOrderCartInfo,storeOrderRefund,storeOrderInvoice,storeOrderPromotions,storePromotions,storeCouponIssue,storePink,storeSeckill,storeBargain,storeCombination,expressCompany,deliveryService,storeConfig,orderWaybillJob,systemAttachment,systemConfig } from '../../src/models/schema';
import { StoreManagerOrderReadService } from '../../src/services/store/StoreManagerOrderReadService';
import { StoreManagerOrderStatisticsService } from '../../src/services/store/StoreManagerOrderStatisticsService';
import { installManagerScopeLock } from '../../src/migrations/runManagerScopeLock';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { storeOrderRefundSplit,storeOrderFulfillmentBranch } from '../../src/models/schema/order_refund_split';
import type { Env } from '../../src/env';
import { integralProductReadFixture,observeIntegralReadDb } from './integralProductReadFixture';
export const managerReadNow=Math.floor(Date.UTC(2026,9,3,4)/1000);
export const managerReadEnv={APP_KEY:'owned-manager-read-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',CONFIG_KV:{get:async()=>null,put:async()=>{},delete:async()=>{}}} as unknown as Env;
export const observeManagerReadDb=observeIntegralReadDb;
export async function storeManagerOrderFixture(){
 const f=await integralProductReadFixture({extraTables:[systemStoreStaff,systemUserLevel,userAddress,storeProductLog,storeOrder,storeOrderCartInfo,storeOrderRefund,storeOrderRefundSplit,storeOrderFulfillmentBranch,storeOrderInvoice,storeOrderPromotions,storePromotions,storeCouponIssue,storePink,storeSeckill,storeBargain,storeCombination,expressCompany,deliveryService,storeConfig,orderWaybillJob]});
 const owner=`cinashop_manager_lock_${randomUUID().replaceAll('-','')}`;
 try{
  await f.exec(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
  await installManagerScopeLock(f.db,owner);
  await f.db.insert(systemStore).values({id:78,name:'另一实际门店',isStore:1,isShow:1,isDel:0});
  await f.db.insert(user).values([{uid:201,account:'actual-manager',pwd:'owned-manager-password',nickname:'实际经理',status:1,isDel:0},{uid:202,account:'actual-customer',pwd:'PRIVATE customer password',nickname:'实际客户',phone:'13900000202',avatar:'/api/assets/51',status:1,isDel:0},{uid:203,account:'other-customer',nickname:'PRIVATE OTHER CUSTOMER',status:1,isDel:0},{uid:204,account:'actual-delivery',nickname:'真实配送员',status:1,isDel:0}].map(row=>({...row,nowMoney:'202.00'})));
  await f.db.insert(systemUserLevel).values({id:20,name:'真实等级',discount:'88.00',isShow:1,isDel:0});
  await f.db.insert(systemAttachment).values([{attId:51,type:3,relationId:202,moduleType:3,fileType:1,imageType:8,name:'attachments/user/202/avatar.png',attDir:'/api/assets/51',attType:'image/png'},{attId:52,type:3,relationId:203,moduleType:3,fileType:1,imageType:8,name:'attachments/user/203/PRIVATE.png',attDir:'/api/assets/52',attType:'image/png'}]);
  await f.db.insert(expressCompany).values({id:51,name:'真实快递',code:'actual',status:1,isShow:1});
  await f.db.insert(deliveryService).values({id:51,type:1,relationId:77,uid:204,nickname:'真实配送员',phone:'13800000204',status:1,isDel:0});
  await f.db.insert(storeProduct).values([{id:201,type:1,relationId:77,storeName:'实际门店商品',keyword:'搜索商品',image:'/api/assets/41',price:'12.34',isShow:1,isDel:0},{id:202,type:1,relationId:78,storeName:'PRIVATE OTHER STORE PRODUCT',isShow:1,isDel:0}]);
  await f.db.insert(systemConfig).values(['balance_func_status','yue_pay_status','pay_weixin_open','ali_pay_status','city_delivery_status','self_delivery_status'].map((menuName,index)=>({id:200+index,menuName,value:'1'})));
  const order=(id:number,values:Partial<typeof storeOrder.$inferInsert>={})=>({id,orderId:`managed-${id}`,unique:`managed-${id}`,uid:202,storeId:77,paid:1,status:0,shippingType:1,payType:'yue',payPrice:'12.34',totalPrice:'12.34',totalNum:1,realName:'实际客户',userPhone:'13900000202',userAddress:'真实地址',addTime:managerReadNow,payTime:managerReadNow,...values});
  const cart=(oid:number,values:Partial<typeof storeOrderCartInfo.$inferInsert>={})=>({id:oid,oid,uid:202,cartId:`cart-${oid}`,productId:201,cartNum:1,surplusNum:1,splitSurplusNum:1,cartInfo:JSON.stringify({productInfo:{id:201,store_name:'实际商品快照',image:'/api/assets/41',price:'12.34',attrInfo:{suk:'红色',image:'/api/assets/41',price:'12.34'}},truePrice:'12.34',sum_true_price:'12.34',vip_sum_truePrice:'0.00'}),...values});
  const reset=async()=>{for(const table of [storeOrderFulfillmentBranch,storeOrderRefundSplit,storeOrderInvoice,storeOrderPromotions,storeOrderRefund,storeOrderCartInfo,storeOrder,systemStoreStaff,storeProductLog,storeConfig])await f.db.delete(table);
    await f.db.update(user).set({status:1,isDel:0,deleteTime:null,level:20,isEverLevel:0,isMoneyLevel:0}).where(eq(user.uid,201));
    await f.db.update(user).set({status:1,isDel:0,deleteTime:null,level:20,avatar:'/api/assets/51'}).where(eq(user.uid,202));
    await f.db.update(systemStore).set({isStore:1,isShow:1,isDel:0}).where(eq(systemStore.id,77));
    await f.db.insert(systemStoreStaff).values({id:201,uid:201,storeId:77,status:1,isDel:0,isManager:1,isAdmin:0,orderStatus:1,verifyStatus:0});
    await f.db.insert(storeOrder).values(order(1));await f.db.insert(storeOrderCartInfo).values(cart(1));
  };await reset();
  type Peer=Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0];
  const installReadSlice=async(peer:Peer)=>{await f.installSelectSlice(peer,'app');await f.exec(`GRANT EXECUTE ON FUNCTION public.manager_lock_scope_v1(integer,integer),public.manager_lock_carrier_v1(text) TO "${peer.role}"`);};
  const installLockSlice=async(peer:Peer)=>{await installReadSlice(peer);const plan=runtimeBusinessPrivilegePlan('app');if(!plan.tables.user?.includes('UPDATE')||plan.updateColumns.system_store?.join(',')!=='id'||plan.tables.system_store?.includes('UPDATE'))throw Error('Actual user/store lock plan changed');await f.exec(`GRANT UPDATE ON public."user" TO "${peer.role}"`);await f.exec(`GRANT UPDATE(id) ON public.system_store TO "${peer.role}"`);};
  return{...f,owner,order,cart,reset,installReadSlice,installLockSlice,readFor:(db:DbClient=f.db)=>new StoreManagerOrderReadService(createContainerFromDb(db),managerReadEnv),statisticsFor:(db:DbClient=f.db)=>new StoreManagerOrderStatisticsService(createContainerFromDb(db)),close:async()=>{try{await f.exec(`DROP OWNED BY "${owner}" CASCADE`);await f.exec(`DROP ROLE "${owner}"`);}finally{await f.close();}}};
 }catch(error){try{await f.exec(`DROP OWNED BY "${owner}" CASCADE`);await f.exec(`DROP ROLE "${owner}"`);}finally{await f.close();}throw error;}
}
