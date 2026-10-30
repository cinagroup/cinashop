import {sql} from 'drizzle-orm';
import {createContainerFromDb,type DbClient} from '@/lib/di';
import {pricingIdentifier} from '@/migrations/checkoutPricingLockCatalog';
import {ADMIN_AUTHORITY_OPERATION_SQL} from '@/migrations/adminAuthorityOperation';
import {ADMIN_PRODUCT_LABEL_OPERATION_SQL,assertAdminProductLabelOperationReady} from '@/migrations/adminProductLabelOperation';
import {financeMemoryPostgres} from './financePostgres';
import {legacyCategory,storeProductLabel,storeProductLabelAuxiliary,storeProduct,storeProductRelation,systemAdmin,systemRole,systemMenus,systemLog,systemAttachment,systemAttachmentCategory} from '@/models/schema';
import {md5} from '@/utils/jwt';
export const productLabelAuthorSchema={legacyCategory,storeProductLabel,storeProductLabelAuxiliary,storeProduct,storeProductRelation,systemAdmin,systemRole,systemMenus,systemLog,systemAttachment,systemAttachmentCategory};
export const productLabelAuthorTables=Object.values(productLabelAuthorSchema);
export const productLabelActor=(id=101,password='product-label-fixture-password')=>({id,authVersion:md5(password),expiresAt:Math.floor(Date.now()/1000)+3600});
export const productLabelValues=(patch:Record<string,unknown>={})=>({label_cate:2,label_name:'新标签',style_type:'1',color:'#123',bg_color:'#fff',border_color:'',icon:'',is_show:'1',status:'1',sort:'2',...patch});
export const productLabelImage=(id:number,patch:Partial<typeof systemAttachment.$inferInsert>={})=>({attId:id,pid:0,type:1,relationId:0,moduleType:1,fileType:1,imageType:8,attDir:`/api/assets/${id}`,sattDir:`/api/assets/${id}`,name:`attachments/admin/1/product-label-${id}.png`,realName:`标签图片${id}`,attType:'image/png',...patch});
export async function seedProductLabelAuthors(db:DbClient){
 await db.insert(systemRole).values([{id:1,rules:'label.manage'},{id:2,rules:'label.view'},{id:3,rules:'product.manage'},{id:4,rules:'901'},{id:5,rules:'1381'}]);
 await db.insert(systemMenus).values([{id:901,type:1,authType:2,apiUrl:'product/label/<id>',methods:'POST'},{id:1381,type:1,authType:1,menuPath:'/admin/product/label',uniqueAuth:'forged-label-page'}]);
 await db.insert(systemAdmin).values([100,101,102,103,104,105].map(id=>({id,account:`product-label-${id}`,pwd:'product-label-fixture-password',level:id===100?0:1,roles:id===100?'':String(id-100)})));
 await db.insert(legacyCategory).values([{id:1,name:'系统默认',group:2},{id:2,name:'常用标签',group:2,sort:10},{id:3,name:'空分组',group:2},{id:4,name:'供应商不可见',group:2,type:2,relationId:77},{id:5,name:'其他group不可见',group:3},{id:6,name:'😀'.repeat(255),group:2,sort:-9,pid:999,other:'历史其他原值',isShow:7,integralMin:-8,integralMax:-9,addTime:-8},{id:7,name:'其他owner不可见',group:2,ownerId:7}]);
 await db.insert(storeProductLabel).values([{id:1,labelCate:1,labelName:'默认标签'},{id:10,labelCate:2,labelName:'标准标签',color:'#123',bgColor:'#fff',sort:9,addTime:1},{id:11,labelCate:2,labelName:'😀'.repeat(255),styleType:3,color:'red',bgColor:'url(legacy)',borderColor:'#abc',icon:'http://legacy.invalid/label.png',sort:-9,isShow:7,status:5,addTime:-8},{id:12,labelCate:2,labelName:'隐藏标签',isShow:0,status:0},{id:13,labelCate:0,labelName:'未分组历史'},{id:20,type:2,relationId:77,labelCate:4,labelName:'供应商不可见'},{id:21,type:0,relationId:99,labelCate:2,labelName:'外域不可见'}]);
 await db.insert(systemAttachment).values([productLabelImage(1),productLabelImage(2,{type:2,relationId:7,name:'attachments/supplier/7/private.png'})]);
 await db.insert(systemAttachmentCategory).values({id:1,pid:0,type:1,relationId:0,fileType:1,name:'平台图片'});
 await db.execute(sql`SELECT setval('public.category_id_seq',100,false),setval('public.store_product_label_id_seq',1000,false)`);
}
/** Sequential actual SQL with restricted sessions; native races use independent LOGINs. */
export async function createAdminProductLabelAuthorFixture(){
 const fixture=await financeMemoryPostgres(productLabelAuthorTables,{namespace:'public'}),admin='product_label_author_admin_fixture',app='product_label_author_app_fixture';
 try{
  const [identity]=await fixture.db.execute(sql`SELECT current_user AS role,current_database() AS database`);
  const names={database:String(identity.database),maintenance:String(identity.role),admin,app};
  await fixture.exec(`CREATE ROLE ${admin} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;CREATE ROLE ${app} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
   REVOKE CREATE ON SCHEMA public FROM PUBLIC;GRANT USAGE ON SCHEMA public TO ${admin},${app};
   GRANT SELECT,UPDATE ON public.system_admin,public.system_role TO ${admin};GRANT SELECT ON public.system_menus,public.system_attachment,public.system_attachment_category TO ${admin};GRANT UPDATE(id) ON public.system_menus TO ${admin};
   GRANT SELECT,INSERT,UPDATE,DELETE ON public.category,public.store_product_label TO ${admin};GRANT SELECT ON public.store_product,public.store_product_relation TO ${admin};GRANT UPDATE(att_id) ON public.system_attachment TO ${admin};GRANT SELECT,INSERT ON public.system_log TO ${admin};
   GRANT SELECT ON public.category,public.store_product_label,public.store_product,public.store_product_relation,public.system_attachment,public.system_attachment_category TO ${app};`);
  for(const table of ['category','store_product_label','system_log']){const [row]=await fixture.db.execute(sql`SELECT pg_get_serial_sequence(${`public.${table}`},'id') AS sequence`);if(typeof row?.sequence==='string')await fixture.exec(`GRANT USAGE ON SEQUENCE ${row.sequence} TO ${admin}`);}
  await fixture.exec(ADMIN_AUTHORITY_OPERATION_SQL);await fixture.exec(ADMIN_PRODUCT_LABEL_OPERATION_SQL);
  await fixture.exec(`GRANT SELECT,INSERT ON public.admin_authority_operation,public.admin_product_label_operation TO ${admin};GRANT SELECT(label_id) ON public.store_product_label_auxiliary TO ${admin};GRANT EXECUTE ON FUNCTION public.admin_authority_menu_lock_v1() TO ${admin};`);
  let active=false;
  async function asRole<T>(role:string,work:()=>Promise<T>):Promise<T>{if(active)throw Error('Product label memory sessions must be sequential');active=true;try{await fixture.exec(`SET SESSION AUTHORIZATION ${pricingIdentifier(role)}`);return await work();}finally{try{await fixture.exec(`SET SESSION AUTHORIZATION ${pricingIdentifier(names.maintenance)}`);const [row]=await fixture.db.execute(sql`SELECT current_user AS role,session_user AS session`);if(row?.role!==names.maintenance||row?.session!==names.maintenance)throw Error('Product label fixture session restoration failed');}finally{active=false;}}}
  const asAdmin=<T>(work:()=>Promise<T>)=>asRole(admin,work);
  await asAdmin(()=>fixture.db.transaction(tx=>assertAdminProductLabelOperationReady(tx)));
  return {...fixture,names,container:createContainerFromDb(fixture.db),asAdmin,asApp:<T>(work:()=>Promise<T>)=>asRole(app,work)};
 }catch(error){await fixture.close();throw error;}
}
