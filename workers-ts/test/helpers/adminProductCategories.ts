import {createContainerFromDb} from '@/lib/di';
import {storeProductCategory,storeProduct,storeProductRelation,storeProductCate,storeProductCategoryBrand,storeCouponIssue,storeCouponTemplate,systemAdmin,systemRole,systemMenus,systemAttachment,systemLog} from '@/models/schema';
import {md5} from '@/utils/jwt';
import {AdminProductCategoryService} from '@/services/admin/AdminProductCategoryService';
import {financePostgres} from './financePostgres';
export const categorySchema={storeProductCategory,storeProduct,storeProductRelation,storeProductCate,storeProductCategoryBrand,storeCouponIssue,storeCouponTemplate,systemAdmin,systemRole,systemMenus,systemAttachment,systemLog};
export const categoryTables=Object.values(categorySchema);
export const categoryActor=(id=101)=>({id,authVersion:md5('category-fixture-password'),expiresAt:Math.floor(Date.now()/1000)+3600});
export const categoryBody=(changes:Record<string,unknown>={})=>({pid:[0],cate_name:'新分类',pic:'',big_pic:'',sort:7,is_show:1,...changes});
export async function seedProductCategories(db:ReturnType<typeof createContainerFromDb>['db']){
  await db.insert(systemRole).values([{id:1,roleName:'分类管理',rules:'category.manage'},{id:2,roleName:'分类查看',rules:'category.view'},{id:3,roleName:'商品选择',rules:'product.view'},{id:4,roleName:'无关',rules:'user.view'},{id:5,roleName:'原始数字管理',rules:'173'},{id:6,roleName:'原始数字选择',rules:'912'}]);
  await db.insert(systemMenus).values([{id:173,type:1,authType:2,apiUrl:'product/category',methods:'POST',menuPath:'/adminproduct/category',uniqueAuth:'product-save-cate',menuName:'分类保存'},
    {id:912,type:1,authType:2,apiUrl:'product/category/cascader_list/<type?>',methods:'GET',menuName:'分类选择'}]);
  await db.insert(systemAdmin).values([100,101,102,103,104,105,106].map(id=>({id,account:`category-${id}`,pwd:'category-fixture-password',level:id===100?0:1,roles:id===100?'':String(id-100)})));
  await db.insert(storeProductCategory).values([{id:1,cateName:'根分类',sort:9},{id:2,cateName:'子分类',pid:1,path:'1',level:1},{id:3,cateName:'三级分类',pid:2,path:'1,2',level:2,addTime:1},
    {id:4,cateName:'其他根'},{id:5,cateName:'其他子',pid:4,path:'4',level:1},{id:6,cateName:'隐藏根',isShow:0},{id:7,cateName:'隐藏根后代',pid:6,path:'6',level:1},
    {id:8,cateName:'门店秘密',type:1,relationId:7},{id:9,cateName:'供应商秘密',type:2,relationId:77},{id:12,cateName:'孤立叶'}]);
}
export async function productCategoryFixture(){const f=await financePostgres(categoryTables,{namespace:'public'});await seedProductCategories(f.db);await f.exec("SELECT setval(pg_get_serial_sequence('store_product_category','id'),100,false)");const container=createContainerFromDb(f.db);return {...f,container,service:new AdminProductCategoryService(container,'category-test-key')};}
