import {createContainerFromDb} from '@/lib/di';
import {legacyCategory,storeProductLabel,storeProductLabelAuxiliary,storeProduct,storeProductRelation,systemAdmin,systemRole,systemMenus,systemAttachment,systemLog} from '@/models/schema';
import {md5} from '@/utils/jwt';
import {AdminProductLabelService} from '@/services/admin/AdminProductLabelService';
import {financePostgres} from './financePostgres';
export const labelTables=[legacyCategory,storeProductLabel,storeProductLabelAuxiliary,storeProduct,storeProductRelation,systemAdmin,systemRole,systemMenus,systemAttachment,systemLog];
export const labelSchema={legacyCategory,storeProductLabel,storeProductLabelAuxiliary,storeProduct,storeProductRelation,systemAdmin,systemRole,systemMenus,systemAttachment,systemLog};
export const labelActor=(id=101)=>({id,authVersion:md5('label-fixture-password'),expiresAt:Math.floor(Date.now()/1000)+3600});
export const labelBody=(changes:Record<string,unknown>={})=>({label_cate:2,label_name:'新品',style_type:1,color:'#123456',bg_color:'#ffffff',border_color:'#ddd',icon:'',is_show:1,status:1,sort:7,...changes});
export async function seedProductLabels(db:ReturnType<typeof createContainerFromDb>['db']){
  await db.insert(systemRole).values([{id:1,roleName:'标签管理',rules:'label.manage'},{id:2,roleName:'标签只读',rules:'label.view'},
    {id:3,roleName:'商品选择',rules:'product.view'},{id:4,roleName:'无关角色',rules:'user.view'},
    {id:5,roleName:'旧numeric管理',rules:'901'},{id:6,roleName:'旧numeric选项',rules:'902'}]);
  await db.insert(systemMenus).values([{id:901,type:1,authType:2,apiUrl:'product/label/<id>',methods:'POST',menuName:'旧标签保存'},
    {id:902,type:1,authType:2,apiUrl:'product/product_label',methods:'GET',menuName:'旧商品选项'}]);
  await db.insert(systemAdmin).values([100,101,102,103,104,105,106].map(id=>({id,account:`label-${id}`,pwd:'label-fixture-password',
    level:id===100?0:1,roles:id===100?'':String(id-100)})));
  await db.insert(legacyCategory).values([{id:1,name:'系统默认',group:2},{id:2,name:'常用',group:2,sort:2},
    {id:3,name:'空分组',group:2},{id:4,name:'供应商分组秘密',group:2,type:2,relationId:77},
    {id:5,name:'参数模板秘密',group:3},{id:6,name:'其他owner秘密',group:2,ownerId:7}]);
  await db.insert(storeProductLabel).values([{id:1,labelName:'默认标签',labelCate:1},
    {id:10,labelName:'旧标签',labelCate:2,sort:10,addTime:1}, {id:11,labelName:'other',labelCate:2,status:0,isShow:0},
    {id:12,labelName:'未分组历史',labelCate:0}, {id:20,labelName:'供应商标签秘密',labelCate:4,type:2,relationId:77}]);
}
export async function productLabelFixture(){
  const fixture=await financePostgres(labelTables,{namespace:'public'});
  await seedProductLabels(fixture.db);
  await fixture.exec("SELECT setval(pg_get_serial_sequence('category','id'),100,false); SELECT setval(pg_get_serial_sequence('store_product_label','id'),1000,false)");
  const container=createContainerFromDb(fixture.db);
  return {...fixture,container,service:new AdminProductLabelService(container,'label-test-app-key')};
}
