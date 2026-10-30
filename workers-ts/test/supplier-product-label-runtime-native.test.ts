import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {eq,sql} from 'drizzle-orm';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createApp} from '@/app';
import type {Env} from '@/env';
import {createContainerFromDb} from '@/lib/di';
import {legacyCategory,storeProductLabel,systemAdmin,systemLog,systemRole,systemSupplier} from '@/models/schema';
import {runRuntimeBusinessCommissioning} from '@/migrations/runRuntimeBusinessCommissioning';
import {auditRuntimeBusinessPrivileges} from '@/migrations/auditRuntimeBusinessPrivileges';
import {runSupplierProductLabelUpgrade} from '@/migrations/runSupplierProductLabelUpgrade';
import {inspectSupplierProductLabelCapability} from '@/migrations/supplierProductLabelCapability';
import {SupplierProductLabelService} from '@/services/supplier/SupplierProductLabelService';
import {createToken,md5} from '@/utils/jwt';
import {refundRuntimeFixture} from './helpers/refundRuntimeFixture';

function causes(error:unknown){
 const result:Array<{code:string;message:string}>=[];
 for(let i=0;i<8&&error&&typeof error==='object';i++){
  result.push({code:'code'in error?String(error.code):'',message:'message'in error?String(error.message):''});
  error='cause'in error?error.cause:null;
 }
 return result;
}

/** Actual production createApp/container/Hyperdrive path. No createContainer
 * mock, SET ROLE, Admin DB port, or additional App table/sequence grants. */
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier label current commissioned App LOGIN and real HTTP boundary',()=>{
 afterEach(()=>vi.restoreAllMocks());
 it('completes owner create, two-value update and physical delete through current App while raw catalog DML remains denied',async()=>{
  vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Owned Supplier label runtime fixture forbids external I/O'));
  const whole=await refundRuntimeFixture();
  try{
   if(!whole.withRuntimeRole)throw Error('Independent native PG16 App/Admin LOGIN required');
   await whole.withRuntimeRole(async app=>whole.withRuntimeRole!(async admin=>{
    const [identity]=await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance`);
    const target={database:String(identity.database),maintenance:String(identity.maintenance),app:app.role,admin:admin.role};
    await runRuntimeBusinessCommissioning(whole.db,{...target,pricingOwner:whole.pricingOwner});
    const audit={app:await auditRuntimeBusinessPrivileges(app.db,'app',target),admin:await auditRuntimeBusinessPrivileges(admin.db,'admin',target)};
    expect(audit).toMatchObject({app:{ready:true,failures:[]},admin:{ready:true,failures:[]}});
    const [login]=await app.exec('SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting(\'server_version_num\') AS version');
    expect(login).toMatchObject({role:app.role,session:app.role,pid:app.pid});expect(Math.floor(Number(login.version)/10000)).toBe(16);
    const owner=`cinashop_runtime_${randomUUID().replaceAll('-','')}`;
    await whole.exec(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    try{
     const capabilityTarget={...target,owner};
     expect(await runSupplierProductLabelUpgrade(whole.db,capabilityTarget)).toEqual({operation:'supplier-product-label-capability-v1',applied:true});
     expect(await inspectSupplierProductLabelCapability(whole.db,capabilityTarget)).toMatchObject({ready:true,absent:false,appRole:app.role});
     expect(await runSupplierProductLabelUpgrade(whole.db,capabilityTarget)).toEqual({operation:'supplier-product-label-capability-v1',applied:false});
     expect(await auditRuntimeBusinessPrivileges(app.db,'app',target)).toMatchObject({ready:true,failures:[]});
     expect(await auditRuntimeBusinessPrivileges(admin.db,'admin',target)).toMatchObject({ready:true,failures:[]});
     const checkout=await whole.operationsFor(app).checkout({key:'supplier-label-neighbor',orderId:'supplier_label_neighbor'});
     expect(checkout.orderId).toBe('supplier_label_neighbor');
    const supplier=990020,actorId=990021,group=991001,editedId=991101,deletedId=991102,password='owned-current-supplier-label-password';
    await whole.db.insert(systemSupplier).values({id:supplier,adminId:990029,supplierName:'Owned current App label supplier'});
    await whole.db.insert(systemRole).values({id:actorId,type:4,relationId:supplier,rules:'supplier.product.manage'});
    await whole.db.insert(systemAdmin).values({id:actorId,account:'owned_current_app_label_writer',pwd:password,adminType:4,relationId:supplier,roles:String(actorId),level:1});
    await whole.db.insert(legacyCategory).values({id:group,type:0,relationId:0,ownerId:0,group:2,name:'Owned current App label group'});
    await whole.db.insert(storeProductLabel).values([
     {id:editedId,type:2,relationId:supplier,labelCate:group,labelName:'原有展示事实',styleType:2,color:'#112233',bgColor:'#abcdef',borderColor:'#123456',icon:'/api/assets/77',isShow:0,status:0,sort:-9,addTime:100},
     {id:deletedId,type:2,relationId:supplier,labelCate:group,labelName:'原生可删标签'},
    ]);
    await whole.exec("SELECT setval(pg_get_serial_sequence('store_product_label','id'),1000000,false)");
    const [acl]=await app.exec("SELECT has_table_privilege(current_user,'public.store_product_label','SELECT') AS read,has_column_privilege(current_user,'public.store_product_label','id','UPDATE') AS lock_only,has_table_privilege(current_user,'public.store_product_label','INSERT') AS insert,has_column_privilege(current_user,'public.store_product_label','label_name','UPDATE') AS update_name,has_table_privilege(current_user,'public.store_product_label','DELETE') AS delete,has_any_column_privilege(current_user,'public.store_product_label_auxiliary','SELECT') AS auxiliary_read");
    expect(acl).toEqual({read:true,lock_only:true,insert:false,update_name:false,delete:false,auxiliary_read:false});
    for(const text of["INSERT INTO public.store_product_label(label_name) VALUES('forbidden App direct label')",`UPDATE public.store_product_label SET label_name='forbidden' WHERE id=${editedId}`,`DELETE FROM public.store_product_label WHERE id=${deletedId}`,'SELECT label_id FROM public.store_product_label_auxiliary LIMIT 0'])await expect(app.exec(text)).rejects.toMatchObject({code:'42501'});
    const env={HYPERDRIVE:{connectionString:app.connectionString},APP_KEY:'owned-current-supplier-label-http',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:''} as unknown as Env;
    try{
    const token=(await createToken(actorId,'supplier',md5(password),env.APP_KEY)).token,http=createApp();
    const request=async(method:string,path:string,body?:unknown)=>{
     const response=await http.request(path,{method,headers:{Authorization:`Bearer ${token}`,'X-Supplier-Id':'999999',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})},env);
     expect(response.headers.get('cache-control')).toContain('private, no-store');
     return {method,path,http_status:response.status,body:await response.json<{status:number;msg:string;data:any}>()};
    };
    const catalog=await request('GET','/supplierapi/product/label/catalog');expect(catalog.body.status,catalog.body.msg).toBe(200);
    expect(catalog.body.data.list.map((row:{id:number})=>row.id).sort((a:number,b:number)=>a-b)).toEqual([editedId,deletedId]);
    const form=await request('GET','/supplierapi/product/label/form');expect(form.body.status,form.body.msg).toBe(200);
    const before=await whole.db.select().from(storeProductLabel).orderBy(storeProductLabel.id),beforeLogs=await whole.db.select().from(systemLog).orderBy(systemLog.id);
    const paths=[['POST','/supplierapi/product/label/0',{label_cate:group,label_name:'原生新增标签'}],['POST',`/supplierapi/product/label/${editedId}`,{label_cate:group,label_name:'原生只改名称'}],['DELETE',`/supplierapi/product/label/${deletedId}`,undefined]] as const;
    const responses=[];
    for(const [method,path,body]of paths)responses.push(await request(method,path,body));
    const service=new SupplierProductLabelService(createContainerFromDb(app.db)),actor={id:actorId,authVersion:md5(password),expiresAt:Math.floor(Date.now()/1000)+3600};
    const direct=[];
    for(const operation of(responses.every(row=>row.body.status!==200)?['create','update','delete']:[])as Array<'create'|'update'|'delete'>){
     try{const value=operation==='delete'?await service.delete(supplier,deletedId,undefined,actor):await service.save(supplier,operation==='create'?0:editedId,{label_cate:group,label_name:operation==='create'?'原生独立创建':'原生独立改名'},actor);direct.push({operation,ok:true,value});}
     catch(error){direct.push({operation,ok:false,causes:causes(error)});}
    }
    const sessions=await whole.db.execute(sql`SELECT usename,application_name,state FROM pg_stat_activity WHERE datname=current_database() AND usename=${app.role} AND application_name='cinashop_api' ORDER BY pid`);
    expect(sessions.length).toBeGreaterThan(0);expect(sessions.every(row=>row.usename===app.role)).toBe(true);
    const after=await whole.db.select().from(storeProductLabel).orderBy(storeProductLabel.id),afterLogs=await whole.db.select().from(systemLog).orderBy(systemLog.id);
    const report={profile:'actual current commissioned App/Admin LOGIN',role:app.role,identity:login,acl,audit,container:'actual createApp -> production containerMiddleware -> createDb(env.HYPERDRIVE), no DI mock',reads:[catalog,form],responses,direct,sessions,labels_unchanged:JSON.stringify(before)===JSON.stringify(after),audit_unchanged:JSON.stringify(beforeLogs)===JSON.stringify(afterLogs)};
    const reportPath=process.env.SUPPLIER_LABEL_RUNTIME_REPORT;if(reportPath)writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
    if(responses.every(row=>row.body.status!==200)){expect(after).toEqual(before);expect(afterLogs).toEqual(beforeLogs);}
    // Same migration behavior first captured red on the genuine current App;
    // now require the explicit narrow capability to close all three routes.
    expect(responses.map(row=>({method:row.method,path:row.path,status:row.body.status,msg:row.body.msg}))).toEqual(paths.map(([method,path])=>({method,path,status:200,msg:expect.any(String)})));
    expect(direct.every(row=>row.ok)).toBe(true);
    const createdId=responses[0]!.body.data.id;expect(Number.isSafeInteger(createdId)&&createdId>0).toBe(true);
    expect(after.find(row=>row.id===createdId)).toMatchObject({type:2,relationId:supplier,labelCate:group,labelName:'原生新增标签',styleType:1,icon:'',isShow:1,status:1,sort:0});
    expect(after.some(row=>row.id===deletedId)).toBe(false);
    expect(after.filter(row=>![createdId,editedId,deletedId].includes(row.id))).toEqual(before.filter(row=>![editedId,deletedId].includes(row.id)));
    expect(afterLogs.slice(beforeLogs.length).map(row=>({adminId:row.adminId,merchantId:row.merchantId,method:row.method,path:row.path,type:row.type}))).toEqual([{adminId:actorId,merchantId:supplier,method:'POST',path:`product/label/${createdId}`,type:'supplier_product_label'},{adminId:actorId,merchantId:supplier,method:'POST',path:`product/label/${editedId}`,type:'supplier_product_label'},{adminId:actorId,merchantId:supplier,method:'DELETE',path:`product/label/${deletedId}`,type:'supplier_product_label'}]);
    const edited=(await whole.db.select().from(storeProductLabel).where(eq(storeProductLabel.id,editedId)))[0]!;
    expect(edited).toMatchObject({type:2,relationId:supplier,styleType:2,color:'#112233',bgColor:'#abcdef',borderColor:'#123456',icon:'/api/assets/77',isShow:0,status:0,sort:-9,addTime:100});
    }finally{
     // Production createApp owns one real postgres-js pool per request. Close
     // only this fixture database's authenticated App HTTP sessions, leaving
     // the independent LOGIN proof peer and all other chats untouched.
     await whole.db.execute(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND usename=${app.role} AND application_name='cinashop_api' AND pid<>pg_backend_pid()`);
     let remaining=-1;for(let attempt=0;attempt<100;attempt++){remaining=Number((await whole.db.execute(sql`SELECT count(*)::integer AS remaining FROM pg_stat_activity WHERE datname=current_database() AND usename=${app.role} AND application_name='cinashop_api'`))[0]!.remaining);if(remaining===0)break;await new Promise(done=>setTimeout(done,10));}expect(remaining).toBe(0);
    }
    }finally{await whole.exec(`DROP OWNED BY "${owner}";DROP ROLE "${owner}"`);}
   }));expect(fetch).not.toHaveBeenCalled();
  }finally{await whole.close();}
 },180000);
});
