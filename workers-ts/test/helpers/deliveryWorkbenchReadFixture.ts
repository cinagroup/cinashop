import { eq } from 'drizzle-orm';
import { createContainerFromDb,type DbClient } from '../../src/lib/di';
import { deliveryService,systemStoreStaff,systemStore,user,storeOrder,storeOrderCartInfo,storeOrderRefund,storeOrderPromotions,storePromotions,storeCouponIssue,storePink } from '../../src/models/schema';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { DeliveryReadService,type DeliveryActionReader } from '../../src/services/store/DeliveryReadService';
import { md5 } from '../../src/utils/jwt';
import { integralProductReadFixture,observeIntegralReadDb } from './integralProductReadFixture';
import type { Env } from '../../src/env';
export const deliveryReadEnv={APP_KEY:'owned-delivery-read-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',CONFIG_KV:{get:async()=>null,put:async()=>{},delete:async()=>{}}} as unknown as Env;
export const deliveryReadNow=Math.floor(Date.UTC(2026,9,3,4)/1000);
export const observeDeliveryReadDb=observeIntegralReadDb;
export async function deliveryWorkbenchReadFixture(){
  const f=await integralProductReadFixture({extraTables:[deliveryService,systemStoreStaff,storeOrder,storeOrderCartInfo,storeOrderRefund,storeOrderPromotions,storePromotions,storeCouponIssue,storePink]});
  try{
    await f.db.insert(systemStore).values({id:78,name:'另一配送门店',isStore:1,isShow:1,isDel:0,latitude:'31.2',longitude:'121.5'});
    await f.db.insert(user).values([{uid:501,account:'actual-delivery-workbench',pwd:'owned-delivery-password',nickname:'实际配送员',status:1,isDel:0},{uid:502,account:'actual-delivery-customer',nickname:'实际收件人',status:1,isDel:0},{uid:503,account:'other-delivery',nickname:'PRIVATE OTHER DELIVERY',status:1,isDel:0}]);
    const order=(id:number,patch:Partial<typeof storeOrder.$inferInsert>={})=>({id,orderId:`assigned-${id}`,unique:`assigned-${id}`,uid:502,storeId:77,deliveryUid:501,deliveryType:'send',paid:1,status:1,shippingType:1,payType:'yue',payPrice:'12.34',totalPrice:'12.34',totalNum:1,realName:'实际收件人',userPhone:'13900000502',userAddress:'真实配送地址',userLocation:'121.500 31.200',verifyCode:'123456789012',addTime:deliveryReadNow,payTime:deliveryReadNow,...patch});
    const cart=(oid:number,patch:Partial<typeof storeOrderCartInfo.$inferInsert>={})=>({id:oid,oid,uid:502,cartId:`delivery-cart-${oid}`,unique:`delivery-${oid}`,productId:70,cartNum:1,surplusNum:1,splitSurplusNum:1,cartInfo:JSON.stringify({productInfo:{id:70,store_name:'实际配送商品',image:'/api/assets/41',price:'12.34',attrInfo:{suk:'红色',image:'/api/assets/41',price:'12.34'}},truePrice:'12.34',vip_truePrice:'0.00',sum_true_price:'12.34',vip_sum_truePrice:'0.00'}),...patch});
    const actor=()=>({uid:501,authVersion:md5('owned-delivery-password'),expiresAt:Math.floor(Date.now()/1000)+600});
    const reset=async()=>{for(const table of [storeOrderPromotions,storeOrderRefund,storeOrderCartInfo,storeOrder,deliveryService,systemStoreStaff,storeCouponIssue,storePink,storePromotions])await f.db.delete(table);
      await f.db.update(user).set({status:1,isDel:0,deleteTime:null,pwd:'owned-delivery-password'}).where(eq(user.uid,501));await f.db.update(systemStore).set({isStore:1,isShow:1,isDel:0,latitude:'31.2',longitude:'121.5'}).where(eq(systemStore.id,77));await f.db.update(systemStore).set({isStore:1,isShow:1,isDel:0}).where(eq(systemStore.id,78));
      await f.db.insert(deliveryService).values([{id:501,uid:501,type:0,relationId:0,nickname:'平台实际配送员',phone:'13800000501',status:1,isDel:0},{id:502,uid:501,type:1,relationId:77,nickname:'门店实际配送员',status:1,isDel:0},{id:503,uid:501,type:1,relationId:78,nickname:'另一门店身份',status:1,isDel:0}]);await f.db.insert(storeOrder).values(order(1));await f.db.insert(storeOrderCartInfo).values(cart(1));
    };await reset();
    type Peer=Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0];
    const installScopeSlice=async(peer:Peer)=>{await f.installSelectSlice(peer,'app');const plan=runtimeBusinessPrivilegePlan('app');if(JSON.stringify(plan.tables.delivery_service)!==JSON.stringify(['SELECT','INSERT','UPDATE'])||JSON.stringify(plan.tables.user)!==JSON.stringify(['SELECT','INSERT','UPDATE'])||JSON.stringify(plan.tables.system_store)!==JSON.stringify(['SELECT'])||plan.updateColumns.system_store?.join(',')!=='id')throw Error('Actual delivery scope application plan changed');await f.exec(`GRANT INSERT,UPDATE ON public.delivery_service TO "${peer.role}"`);await f.exec(`GRANT UPDATE ON public."user" TO "${peer.role}"`);await f.exec(`GRANT UPDATE(id) ON public.system_store TO "${peer.role}"`);};
    return{...f,actor,order,cart,reset,env:deliveryReadEnv,installReadSlice:(peer:Peer)=>f.installSelectSlice(peer,'app'),installScopeSlice,readFor:(db:DbClient=f.db,actions?:DeliveryActionReader)=>new DeliveryReadService(createContainerFromDb(db),deliveryReadEnv,actions)};
  }catch(error){await f.close();throw error;}
}
