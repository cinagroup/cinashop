import {createContainerFromDb} from '@/lib/di';
import {systemGroup,systemGroupData,systemAdmin,systemRole,systemMenus,systemAttachment,systemLog,systemSupplier} from '@/models/schema';
import {md5} from '@/utils/jwt';
import {AdminOperationalGroupDataService} from '@/services/admin/AdminOperationalGroupDataService';
import {OPERATIONAL_GROUPS} from '@/services/admin/AdminOperationalGroupDataInput';
import {R2_IMAGE_TYPE} from '@/services/system/AttachmentService';
import {financePostgres} from './financePostgres';
export const operationalSchema={systemGroup,systemGroupData,systemAdmin,systemRole,systemMenus,systemAttachment,systemLog,systemSupplier};
export const operationalTables=Object.values(operationalSchema);
export const operationalActor=(id=101)=>({id,authVersion:md5('operational-fixture-password'),expiresAt:Math.floor(Date.now()/1000)+3600});
export const operationalBody=(changes:Record<string,unknown>={})=>({gid:51,img:'https://images.example.test/banner.jpg',comment:'推荐商品',link:'/pages/goods_details/index?id=70',sort:1,status:1,...changes});
export const operationalMetadata=JSON.stringify([{name:'图片',title:'img',type:'upload',param:''},{name:'描述',title:'comment',type:'input',param:''},{name:'跳转链接',title:'link',type:'input',param:''}]);
export const operationalStored=(changes:Record<string,unknown>={})=>JSON.stringify({img:{type:'upload',value:'https://images.example.test/banner.jpg'},comment:{type:'input',value:'原推荐'},link:{type:'input',value:'/pages/goods_details/index?id=70'},...changes});
export async function seedOperationalGroups(db:ReturnType<typeof createContainerFromDb>['db']){
  await db.insert(systemGroup).values(Object.keys(OPERATIONAL_GROUPS).map((configName,index)=>({id:[51,52,57,58,59,68][index],cateId:1,name:OPERATIONAL_GROUPS[configName as keyof typeof OPERATIONAL_GROUPS],configName,fields:operationalMetadata})));
  await db.insert(systemGroup).values([{id:66,configName:'pc_home_banner',fields:operationalMetadata},{id:55,configName:'sign_day_num',fields:operationalMetadata},{id:54,configName:'routine_my_menus',fields:operationalMetadata},{id:67,configName:'routine_my_banner',fields:operationalMetadata},{id:62,configName:'user_recharge_quota',fields:operationalMetadata},{id:49,configName:'routine_seckill_time',fields:operationalMetadata}]);
  await db.insert(systemGroupData).values([{id:1,gid:51,value:operationalStored(),sort:5,addTime:1},{id:2,gid:51,value:operationalStored(),sort:5,status:0,addTime:2},{id:3,gid:52,value:operationalStored(),sort:1},{id:4,gid:66,value:operationalStored()}]);
  await db.insert(systemRole).values([{id:1,roleName:'运营管理',rules:'operational_group.manage'},{id:2,roleName:'运营查看',rules:'operational_group.view'},{id:3,roleName:'数字运营写',rules:'485'},{id:4,roleName:'配置其他',rules:'config.manage'}]);
  await db.insert(systemMenus).values([{id:485,type:1,authType:2,apiUrl:'setting/group_data',methods:'POST',menuName:'添加组合数据'}]);
  await db.insert(systemAdmin).values([100,101,102,103,104].map(id=>({id,account:`operational-${id}`,pwd:'operational-fixture-password',level:id===100?0:1,roles:id===100?'':String(id-100)})));
  await db.insert(systemAttachment).values([{attId:71,name:'attachments/admin/1/banner.jpg',attDir:'/api/assets/71',attType:'image/jpeg',imageType:R2_IMAGE_TYPE,fileType:1,moduleType:1,type:1,relationId:0},{attId:72,name:'attachments/supplier/77/private.jpg',attDir:'/api/assets/72',attType:'image/jpeg',imageType:R2_IMAGE_TYPE,fileType:1,moduleType:1,type:4,relationId:77}]);
}
export async function operationalGroupFixture(){const f=await financePostgres(operationalTables,{namespace:'public'});await seedOperationalGroups(f.db);await f.exec("SELECT setval(pg_get_serial_sequence('system_group_data','id'),100,false)");const container=createContainerFromDb(f.db);return {...f,container,service:new AdminOperationalGroupDataService(container,'operational-test-key')};}
