import {createContainerFromDb} from '@/lib/di';
import {storeBrand,storeProduct,storeProductRelation,storeProductCategoryBrand,storePromotionsAuxiliary,storeCouponIssue,systemAdmin,systemRole,systemMenus,systemLog} from '@/models/schema';
import {md5} from '@/utils/jwt';
import {AdminProductBrandService} from '@/services/admin/AdminProductBrandService';
import {financePostgres} from './financePostgres';
export const brandSchema={storeBrand,storeProduct,storeProductRelation,storeProductCategoryBrand,storePromotionsAuxiliary,storeCouponIssue,systemAdmin,systemRole,systemMenus,systemLog};
export const brandTables=Object.values(brandSchema);
export const brandActor=(id=101)=>({id,authVersion:md5('brand-fixture-password'),expiresAt:Math.floor(Date.now()/1000)+3600});
export const brandBody=(changes:Record<string,unknown>={})=>({fid:[0],brand_name:'新品牌',sort:7,is_show:1,...changes});
export async function seedProductBrands(db:ReturnType<typeof createContainerFromDb>['db']){
  await db.insert(systemRole).values([{id:1,roleName:'品牌管理',rules:'brand.manage'},{id:2,roleName:'品牌查看',rules:'brand.view'},{id:3,roleName:'商品选择',rules:'product.view'},{id:4,roleName:'无关',rules:'user.view'},{id:5,roleName:'numeric管理',rules:'1341'},{id:6,roleName:'numeric选择',rules:'1340'}]);
  await db.insert(systemMenus).values([{id:1341,type:1,authType:2,apiUrl:'product/brand',methods:'POST',menuName:'品牌创建'},{id:1340,type:1,authType:2,apiUrl:'product/brand/cascader_list/<type?>',methods:'GET',menuName:'品牌选择'}]);
  await db.insert(systemAdmin).values([100,101,102,103,104,105,106].map(id=>({id,account:`brand-${id}`,pwd:'brand-fixture-password',level:id===100?0:1,roles:id===100?'':String(id-100)})));
  await db.insert(storeBrand).values([{id:1,brandName:'根品牌',sort:9},{id:2,brandName:'子品牌',pid:1,fid:'1'},{id:3,brandName:'三级品牌',pid:2,fid:'1,2',addTime:1},{id:4,brandName:'其他根'},{id:5,brandName:'其他子',pid:4,fid:'4'},{id:6,brandName:'隐藏根',isShow:0},{id:7,brandName:'隐藏根后代',pid:6,fid:'6'},{id:8,brandName:'门店秘密',storeId:7},{id:9,brandName:'门店子',storeId:7,pid:8,fid:'8'},{id:12,brandName:'孤立叶'}]);
}
export async function productBrandFixture(){
  const f=await financePostgres(brandTables,{namespace:'public'});await seedProductBrands(f.db);await f.exec("SELECT setval(pg_get_serial_sequence('store_brand','id'),100,false)");
  const container=createContainerFromDb(f.db);return {...f,container,service:new AdminProductBrandService(container)};
}
