import { eq } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { createContainerFromDb,type DbClient } from '../../src/lib/di';
import { systemAdmin,systemRole,systemMenus,systemLog,systemGroup,systemGroupData,userRelation,systemUserLevel,systemStoreStaff,deliveryService,storeOrder,storeOrderRefund,storeOrderCartInfo,storeCouponUser,storeProductLog,systemMessage,userMessage,userBrokerage,userExtract,video,user,systemDise,systemConfig,storeService } from '../../src/models/schema';
import { integralProductReadFixture,observeIntegralReadDb } from './integralProductReadFixture';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { cloneUserCenterDesign } from '../../../view/common/userCenterDesign';
import { AdminUserCenterDesignService } from '../../src/services/admin/AdminUserCenterDesignService';
import { UserCenterPublicReadService } from '../../src/services/content/UserCenterPublicReadService';
import { UserProfileService,type PaymentCodeStore } from '../../src/services/user/UserProfileService';
import type { Env } from '../../src/env';
export const userCenterEnv={APP_KEY:'owned-user-center-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',CONFIG_KV:{get:async()=>null,put:async()=>{},delete:async()=>{}}} as unknown as Env;
export const observeUserCenterDb=observeIntegralReadDb;
const ident=(name:string)=>{if(!/^[a-z_][a-z_0-9]*$/.test(name))throw Error('Invalid owned user-center identifier');return `"${name}"`;};
export async function userCenterDesignFixture(){
  const f=await integralProductReadFixture({extraTables:[systemAdmin,systemRole,systemMenus,systemLog,systemGroup,systemGroupData,userRelation,systemUserLevel,systemStoreStaff,deliveryService,storeOrder,storeOrderRefund,storeOrderCartInfo,storeCouponUser,storeProductLog,systemMessage,userMessage,userBrokerage,userExtract,video,storeService]});
  try{
    const value=cloneUserCenterDesign();value.member={style:1,property:[0,1,2,3,4],per_show_type:0};value.poster.list=[{sourceId:null,name:'真实广告',pic:'/api/assets/41',url:'/pages/index/index'}];value.menu.list=[{sourceId:null,name:'余额',pic:'/api/assets/41',url:'/pages/users/user_money/index',type:1}];value.merMenu.list=[{sourceId:null,name:'核销',pic:'/api/assets/41',url:'/pages/admin/order_cancellation/index',type:2},{sourceId:null,name:'历史工作台',pic:'/api/assets/41',url:'/pages/admin/work/index',type:2}];
    const stored=JSON.parse(JSON.stringify(value));for(const module of ['poster','menu','merMenu'])stored[module].list=stored[module].list.map(({sourceId,...item}:Record<string,unknown>)=>({...item,opaque:{source:'PRIVATE ITEM',decimal:1.25}}));stored.member.avatar_url='PRIVATE OLD DEFAULT AVATAR';stored.member.is_default=1;stored.opaque={note:'PRIVATE USER CENTER',decimal:1.25};
    await f.db.insert(systemDise).values({id:88,templateName:'member',type:3,status:0,isShow:0,isDel:0,value:JSON.stringify(stored),version:'incoming-member',addTime:10,updateTime:20,content:'PRIVATE metadata'});
    await f.db.insert(systemGroup).values([{id:60,configName:'routine_my_banner',name:'广告',fields:'[]'},{id:61,configName:'routine_my_menus',name:'菜单',fields:'[]'},{id:62,configName:'pc_home_banner',name:'PC',fields:'[]'}]);
    const wrap=(item:Record<string,unknown>)=>Object.fromEntries(Object.entries(item).map(([key,value])=>[key,{type:key==='pic'?'upload':'input',value,opaque:'PRIVATE WRAPPER'}]));
    await f.db.insert(systemGroupData).values([{id:600,gid:60,sort:1,value:JSON.stringify(wrap(stored.poster.list[0]))},{id:601,gid:61,sort:3,value:JSON.stringify(wrap(stored.menu.list[0]))},{id:602,gid:61,sort:2,value:JSON.stringify(wrap(stored.merMenu.list[0]))},{id:603,gid:61,sort:1,value:JSON.stringify(wrap(stored.merMenu.list[1]))},{id:604,gid:61,sort:0,status:0,value:'{"opaque":{"value":"PRIVATE DISABLED"}}'},{id:620,gid:62,value:'{"opaque":"PC UNCHANGED"}'}]);
    await f.db.update(user).set({nickname:'实际用户',phone:'13900000011',avatar:'/api/assets/41',nowMoney:'91.23',integral:27,brokeragePrice:'80.00',isPromoter:1,spreadOpen:1,level:1}).where(eq(user.uid,11));
    await f.db.insert(user).values([{uid:22,nickname:'其他用户',spreadUid:11,status:1,isDel:0},{uid:33,nickname:'已删下线',spreadUid:11,status:1,isDel:1}]);
    await f.db.insert(systemUserLevel).values({id:1,name:'实际会员',discount:'88.50',isShow:1,isDel:0});
    await f.db.insert(systemConfig).values(['balance_func_status','member_func_status','member_card_status','brokerage_func_status','video_func_status'].map((menuName,index)=>({id:100+index,menuName,value:'1'})));
    await f.db.insert(systemStoreStaff).values({id:1,uid:11,storeId:77,status:1,isDel:0,verifyStatus:1,isManager:1,orderStatus:1});
    const now=Math.floor(Date.now()/1000);await f.db.insert(storeOrder).values([{id:1,orderId:'owned-unpaid',unique:'owned-unpaid',uid:11,paid:0,status:0,payPrice:'10.00',addTime:now},{id:2,orderId:'owned-paid',unique:'owned-paid',uid:11,spreadUid:11,paid:1,status:1,storeId:77,payPrice:'21.00'},{id:3,orderId:'foreign-paid',unique:'foreign-paid',uid:22,paid:1,status:1,storeId:999,payPrice:'999.00'}]);
    await f.db.insert(storeOrderCartInfo).values({oid:1,cartId:'1',cartInfo:'{"productInfo":{"image":"/api/assets/41","store_name":"实际未支付商品"}}'});
    await f.db.insert(storeCouponUser).values({uid:11,status:0,isFail:0});
    await f.db.insert(userRelation).values([{uid:11,type:'collect',category:'product',relationId:70},{uid:11,type:'collect',category:'video',relationId:100},{uid:22,type:'collect',category:'video',relationId:101}]);
    await f.db.insert(storeProductLog).values({uid:11,productId:70,type:'visit'});
    await f.db.insert(systemMessage).values({id:1,status:1,isDel:0,type:0,userId:11,look:0,title:'真实消息'});
    await f.db.insert(userBrokerage).values({uid:11,number:'30.00',pm:1,status:1,type:'brokerage',frozenTime:now+600});
    await f.db.insert(video).values([{id:100,image:'/api/assets/41',videoUrl:'https://media.example.com/video.mp4',desc:'公开视频',isShow:1,isVerify:1,isDel:0},{id:101,image:'/api/assets/43',videoUrl:'javascript:PRIVATE',desc:'PRIVATE UNREVIEWED',isVerify:0}]);
    for(const table of f.tables){const d=getTableConfig(table);for(const c of d.columns)if(['serial','bigserial'].includes(c.getSQLType()))await f.exec(`SELECT setval(pg_get_serial_sequence('public.${d.name}','${c.name}'),GREATEST(COALESCE((SELECT MAX(${ident(c.name)}) FROM ${ident(d.name)}),0),1),true)`);}
    type Peer=Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0];
    const installSlice=async(app:Peer,admin:Peer)=>{await f.installSelectSlice(app,'app');const plan=runtimeBusinessPrivilegePlan('admin');for(const table of f.tables){const d=getTableConfig(table),privileges=plan.tables[d.name];if(!privileges?.includes('SELECT'))throw Error(`Admin cannot read ${d.name}`);await f.exec(`GRANT ${privileges.join(',')} ON ${ident(d.name)} TO ${ident(admin.role)}`);const columns=plan.updateColumns[d.name];if(columns?.length)await f.exec(`GRANT UPDATE(${columns.map(ident).join(',')}) ON ${ident(d.name)} TO ${ident(admin.role)}`);if(privileges.includes('INSERT'))for(const c of d.columns)if(['serial','bigserial'].includes(c.getSQLType())){const [row]=await f.exec(`SELECT pg_get_serial_sequence('public.${d.name}','${c.name}') AS name`);const parts=String(row.name).split('.');if(parts.length!==2||parts[0]!=='public')throw Error('Unexpected owned usercenter sequence');await f.exec(`GRANT USAGE ON SEQUENCE public.${ident(parts[1])} TO ${ident(admin.role)}`);}}};
    return{...f,env:userCenterEnv,installSlice,designFor:(db:DbClient=f.db)=>new AdminUserCenterDesignService(createContainerFromDb(db),userCenterEnv),publicFor:(db:DbClient=f.db)=>new UserCenterPublicReadService(createContainerFromDb(db),userCenterEnv),codeFor:(store:PaymentCodeStore,db:DbClient=f.db)=>new UserProfileService(createContainerFromDb(db),userCenterEnv,store),settingsSnapshot:async()=>({member:await f.db.select().from(systemDise).orderBy(systemDise.id),groups:await f.db.select().from(systemGroup).orderBy(systemGroup.id),data:await f.db.select().from(systemGroupData).orderBy(systemGroupData.id),logs:await f.db.select().from(systemLog).orderBy(systemLog.id)})};
  }catch(error){await f.close();throw error;}
}

/** An actual customer-only actor, including the valid chat-disabled case. */
export async function customerWorkEntryFixture(){
  const f=await userCenterDesignFixture();
  try{
    await f.db.update(systemStoreStaff).set({isManager:0,isAdmin:0,orderStatus:0,verifyStatus:0}).where(eq(systemStoreStaff.id,1));
    await f.db.insert(storeService).values({id:7,uid:11,status:0,accountStatus:1,isDel:0,customer:1,account:'customer-entry',password:'PRIVATE customer-password',nickname:'手机订单管理'});
    const [row]=await f.db.select().from(systemDise).where(eq(systemDise.id,88)),design=JSON.parse(row.value!);
    for(const group of ['poster','menu','merMenu'])design[group].list=[{name:'手机经营',pic:'/api/assets/41',url:'/pages/admin/work/index',...(group==='poster'?{}:{type:group==='menu'?2:1})}];
    await f.db.update(systemDise).set({value:JSON.stringify(design)}).where(eq(systemDise.id,88));
    return f;
  }catch(error){await f.close();throw error;}
}
