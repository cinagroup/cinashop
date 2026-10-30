import {sql} from 'drizzle-orm';
import {createContainerFromDb,type DbClient} from '@/lib/di';
import {pricingIdentifier} from '@/migrations/checkoutPricingLockCatalog';
import {ADMIN_AUTHORITY_OPERATION_SQL} from '@/migrations/adminAuthorityOperation';
import {ADMIN_HOTWORD_OPERATION_SQL,assertAdminHotwordOperationReady} from '@/migrations/adminHotwordOperation';
import {financeMemoryPostgres} from './financePostgres';
import {storeProductWords,systemAdmin,systemRole,systemMenus,systemLog,systemAttachment,systemAttachmentCategory} from '@/models/schema';
import {md5} from '@/utils/jwt';
const tables=[storeProductWords,systemAdmin,systemRole,systemMenus,systemLog,systemAttachment,systemAttachmentCategory];
export const hotwordActor=(id=101,password='hotword-fixture-password')=>({id,authVersion:md5(password),expiresAt:Math.floor(Date.now()/1000)+3600});
export const hotwordValues=(patch:Record<string,unknown>={})=>({name:'新热词',color:'#123',bg_color:'#fff',border_color:'',icon:'',sort:'2',is_search:'0',is_show:'1',...patch});
export const hotwordImage=(id:number,patch:Partial<typeof systemAttachment.$inferInsert>={})=>({attId:id,pid:0,type:1,relationId:0,moduleType:1,fileType:1,imageType:8,attDir:`/api/assets/${id}`,sattDir:`/api/assets/${id}`,name:`attachments/admin/1/hotword-${id}.png`,realName:`热词图片${id}`,attType:'image/png',...patch});
export async function seedHotwords(db:DbClient){
 await db.insert(systemRole).values([{id:1,rules:'product.manage'},{id:2,rules:'product.view'},{id:3,rules:'user.manage'},{id:4,rules:'1501'},{id:5,rules:'1502'}]);
 await db.insert(systemMenus).values([{id:1501,type:1,authType:2,apiUrl:'product/words/<id>',methods:'POST'},{id:1502,type:1,authType:1,menuPath:'/admin/product/hotWords',uniqueAuth:'forged-product-page'}]);
 await db.insert(systemAdmin).values([100,101,102,103,104,105].map(id=>({id,account:`hotword-${id}`,pwd:'hotword-fixture-password',level:id===100?0:1,roles:id===100?'':String(id-100)})));
 await db.insert(storeProductWords).values([
  {id:10,name:'标准热词',color:'#123',bgColor:'#fff',borderColor:'',icon:'',sort:9,isShow:1,isSearch:0,isHot:1,addTime:1},
  {id:11,name:'😀'.repeat(128),color:'red',bgColor:'url(legacy)',borderColor:'#abc',icon:'http://legacy.invalid/icon.png',sort:-9,isShow:7,isSearch:5,isHot:3,addTime:-8},
  {id:12,name:'隐藏热词',isShow:0,isSearch:0,sort:1,addTime:0},
  {id:20,type:2,relationId:7,name:'供应商不可见',isShow:1},
  {id:21,type:0,relationId:99,name:'外域不可见',isShow:1},
  {id:30,name:'已删除热词',isDel:1,isShow:1},
 ]);
 await db.insert(systemAttachment).values([hotwordImage(1),hotwordImage(2,{type:2,relationId:7,name:'attachments/supplier/7/private.png'})]);
 await db.insert(systemAttachmentCategory).values({id:1,pid:0,type:1,relationId:0,fileType:1,name:'平台图片'});
 await db.execute(sql`SELECT setval('public.store_product_words_id_seq',1000,false)`);
}
/** Sequential PGlite restricted-role evidence. Actual independent LOGIN and
 * lock races are covered separately by the owned native PG16 test. */
export async function createAdminHotwordAuthorFixture(){
 const fixture=await financeMemoryPostgres(tables,{namespace:'public'}),admin='hotword_author_admin_fixture',app='hotword_author_app_fixture';
 try{
  const [identity]=await fixture.db.execute(sql`SELECT current_user AS role,current_database() AS database`);
  const names={database:String(identity.database),maintenance:String(identity.role),admin,app};
  await fixture.exec(`CREATE ROLE ${admin} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
   CREATE ROLE ${app} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
   REVOKE CREATE ON SCHEMA public FROM PUBLIC;GRANT USAGE ON SCHEMA public TO ${admin},${app};
   GRANT SELECT,UPDATE ON public.system_admin,public.system_role TO ${admin};
   GRANT SELECT ON public.system_menus,public.system_attachment,public.system_attachment_category TO ${admin};GRANT UPDATE(id) ON public.system_menus TO ${admin};
   GRANT SELECT,INSERT,UPDATE,DELETE ON public.store_product_words TO ${admin};
   GRANT UPDATE(att_id) ON public.system_attachment TO ${admin};GRANT SELECT,INSERT ON public.system_log TO ${admin};
   GRANT SELECT ON public.store_product_words,public.system_attachment,public.system_attachment_category TO ${app};`);
  for(const table of ['store_product_words','system_log']){const [row]=await fixture.db.execute(sql`SELECT pg_get_serial_sequence(${`public.${table}`},'id') AS sequence`);if(typeof row?.sequence==='string')await fixture.exec(`GRANT USAGE ON SEQUENCE ${row.sequence} TO ${admin}`);}
  await fixture.exec(ADMIN_AUTHORITY_OPERATION_SQL);await fixture.exec(ADMIN_HOTWORD_OPERATION_SQL);
  await fixture.exec(`GRANT SELECT,INSERT ON public.admin_authority_operation,public.admin_hotword_operation TO ${admin};GRANT EXECUTE ON FUNCTION public.admin_authority_menu_lock_v1() TO ${admin};`);
  let active=false;
  async function asRole<T>(role:string,work:()=>Promise<T>):Promise<T>{if(active)throw Error('Hotword memory sessions must be sequential');active=true;try{await fixture.exec(`SET SESSION AUTHORIZATION ${pricingIdentifier(role)}`);return await work();}finally{try{await fixture.exec(`SET SESSION AUTHORIZATION ${pricingIdentifier(names.maintenance)}`);const [row]=await fixture.db.execute(sql`SELECT current_user AS role,session_user AS session`);if(row?.role!==names.maintenance||row?.session!==names.maintenance)throw Error('Hotword fixture session restoration failed');}finally{active=false;}}}
  const asAdmin=<T>(work:()=>Promise<T>)=>asRole(admin,work);
  await asAdmin(()=>fixture.db.transaction(tx=>assertAdminHotwordOperationReady(tx)));
  return {...fixture,names,container:createContainerFromDb(fixture.db),asAdmin,asApp:<T>(work:()=>Promise<T>)=>asRole(app,work)};
 }catch(error){await fixture.close();throw error;}
}
