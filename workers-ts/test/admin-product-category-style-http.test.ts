/** Actual registered Hono app/JWT; only the connection factory boundary is
 * supplied. Two separate LOGINs retain their real current privilege intersection. */
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import { createContainerFromDb,type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { systemAdmin,systemDise,systemLog,systemMenus,systemRole } from '../src/models/schema';
import { AdminPermissionService } from '../src/services/admin/AdminPermissionService';
import { categoryStyleInput } from '../src/services/admin/AdminProductCategoryStyleInput';
import { themeHash } from '../src/services/content/ThemeReadService';
import { createToken,md5 } from '../src/utils/jwt';
import { categoryEnv,productCategoryStyleFixture } from './helpers/productCategoryStyleFixture';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('../src/lib/di',async original=>({...await original<typeof import('../src/lib/di')>(),createContainer:()=>{if(!wiring.container)throw Error('Owned category HTTP fixture unavailable');return wiring.container;}}));
const env={...categoryEnv};
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('registered category style HTTP with genuine JWT and real App/Admin LOGINs',()=>{
  let f:Awaited<ReturnType<typeof productCategoryStyleFixture>>,fetchGuard:ReturnType<typeof vi.spyOn>;
  const app=createApp(),tokens=new Map<number,string>(),actors={manager:1,reader:2,legacy:3,generic:4,wrongPath:5,wrongAuth:6,second:8,pc:9};
  beforeEach(async()=>{
    f=await productCategoryStyleFixture();await f.db.insert(systemMenus).values([
      {id:1593,type:1,authType:1,access:1,uniqueAuth:'admin-setting-pages-product_category',menuPath:'/admin/setting/pages/product_category'},
      {id:91001,type:1,authType:1,access:1,uniqueAuth:'admin-setting-pages-product_category',menuPath:'/admin/setting/other'},
      {id:91002,type:1,authType:1,access:1,uniqueAuth:'admin-setting-other',menuPath:'/admin/setting/pages/product_category'},
      {id:1036,type:1,authType:1,access:1,uniqueAuth:'admin-setting-pc_setting',menuPath:'/admin/setting/pc_setting'},
    ]);
    const rules:Record<string,string>={manager:'product_category_style.manage',reader:'product_category_style.view',legacy:'1593',generic:'config.manage,dise.manage,category.manage',wrongPath:'91001',wrongAuth:'91002',second:'product_category_style.manage',pc:'1036'};
    await f.db.insert(systemRole).values(Object.entries(actors).map(([name,id])=>({id,type:1,roleName:name,rules:rules[name]})));
    await f.db.insert(systemAdmin).values(Object.entries(actors).map(([name,id])=>({id,account:`category-${name}`,pwd:'owned-category-password',level:1,roles:String(id),adminType:1,status:1,isDel:0})));
    for(const id of Object.values(actors))tokens.set(id,(await createToken(id,'admin',md5('owned-category-password'),env.APP_KEY)).token);
    fetchGuard=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Category settings cannot call provider HTTP'));
  },30000);
  afterEach(async()=>{try{if(fetchGuard)expect(fetchGuard).not.toHaveBeenCalled();}finally{fetchGuard?.mockRestore();tokens.clear();wiring.container=undefined;await f?.close();}},30000);
  type Peer=Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0];
  const profiles=(run:(admin:Peer)=>Promise<void>)=>f.withRuntimeRole(appPeer=>f.withRuntimeRole(async admin=>{
    await f.installSlice(appPeer,admin);for(const peer of[appPeer,admin])expect((await peer.exec('SELECT current_user,session_user'))[0]).toEqual({current_user:peer.role,session_user:peer.role});expect(appPeer.pid).not.toBe(admin.pid);
    wiring.container=createContainerFromDb(appPeer.db);Object.assign(env,{HYPERDRIVE:{connectionString:appPeer.connectionString} as Env['HYPERDRIVE'],HYPERDRIVE_ADMIN:{connectionString:admin.connectionString} as Env['HYPERDRIVE_ADMIN']});
    try{await run(admin);}finally{wiring.container=undefined;}
  }));
  async function request(prefix:string,actor:number|null,suffix='',method='GET',body?:unknown,raw?:string,path='/config/product-category-style'){
    const response=await app.request(`${prefix}${path}${suffix}`,{method,headers:{...(actor===null?{}:{Authorization:`Bearer ${tokens.get(actor)}`}),...(body===undefined&&raw===undefined?{}:{'Content-Type':'application/json'})},...(raw!==undefined?{body:raw}:body===undefined?{}:{body:JSON.stringify(body)})},env);
    return{response,body:await response.json<{status:number;msg:string;data:any}>()};
  }
  const page=async(prefix='/adminapi')=>(await request(prefix,actors.manager)).body.data;
  const input=(revision:string,level=3,index=3)=>({operationId:crypto.randomUUID(),revision,level,index});
  it.each(['/adminapi','/api/admin'])('writes and restores an actor-bound exact receipt; public shares authority and other fields on %s',async prefix=>{await profiles(async()=>{
    const before=await f.settingsSnapshot(),initial=await request(prefix,actors.reader);expect(initial.body).toMatchObject({status:200,data:{value:{level:2,index:1},configured:true,editable:true}});expect(initial.response.headers.get('Cache-Control')).toContain('no-store');expect(await f.settingsSnapshot()).toEqual(before);
    const body=input(initial.body.data.revision),saved=await request(prefix,actors.manager,'/save','POST',body);expect(saved.response.status).toBe(200);expect(saved.body.data).toEqual({operation:'update',id:88,operationId:body.operationId,payloadHash:await themeHash(categoryStyleInput(body).canonical)});
    expect((await request(prefix,actors.manager,`/receipt/${body.operationId}`)).body.data).toEqual(saved.body.data);const committed=await f.settingsSnapshot();expect((await request(prefix,actors.manager,'/save','POST',body)).body.data).toEqual(saved.body.data);expect(await f.settingsSnapshot()).toEqual(committed);
    const publicValue=await request('/api/v2',null,'','GET',undefined,undefined,'/diy/product_detail');expect(publicValue.body).toMatchObject({status:200,data:{product_category:{level:3,index:3,configured:true,issues:[]},product_detail:{showService:[2]},product_video_status:false}});expect(await f.settingsSnapshot()).toEqual(committed);
  });});
  it('grants exact legacy1593 view only in single/batched resolution and rejects unrelated permissions and forged menu pairs',async()=>{await profiles(async admin=>{
    const body=input((await page()).revision),before=await f.settingsSnapshot();
    for(const prefix of['/adminapi','/api/admin']){
      for(const actor of[actors.reader,actors.legacy]){expect((await request(prefix,actor)).body.status).toBe(200);expect((await request(prefix,actor,'/save','POST',body)).body.status).toBe(400011);}
      for(const actor of[actors.generic,actors.wrongPath,actors.wrongAuth,actors.pc]){expect((await request(prefix,actor)).body.status).toBe(400011);expect((await request(prefix,actor,'/save','POST',body)).body.status).toBe(400011);}
      expect((await request(prefix,null)).body.status).toBe(410000);
    }
    const permissions=new AdminPermissionService(createContainerFromDb(admin.db));expect(await permissions.resolveRulePermissionKeys('1593')).toEqual(['product_category_style.view']);expect(await permissions.resolveManyRulePermissionKeys(['1593','91001','91002'])).toEqual([['product_category_style.view'],[],[]]);
    for(const patch of[{uniqueAuth:'wrong'},{menuPath:'/admin/setting/other'},{type:2},{authType:2},{access:0},{isDel:1}]){
      await f.db.update(systemMenus).set({uniqueAuth:'admin-setting-pages-product_category',menuPath:'/admin/setting/pages/product_category',type:1,authType:1,access:1,isDel:0,...patch}).where(eq(systemMenus.id,1593));
      expect(await permissions.resolveRulePermissionKeys('1593')).toEqual([]);expect(await permissions.resolveManyRulePermissionKeys(['1593'])).toEqual([[]]);expect((await request('/adminapi',actors.legacy)).body.status).toBe(400011);
    }
    const after=await f.settingsSnapshot();expect(after.rows).toEqual(before.rows);expect(after.logs).toEqual(before.logs);
  });});
  it.each(['/adminapi','/api/admin'])('returns actual matched409/400 only after rollback and real404 receipt absence on %s',async prefix=>{await profiles(async()=>{
    const body=input((await page(prefix)).revision);await f.db.update(systemDise).set({content:'peer metadata'}).where(eq(systemDise.id,88));let before=await f.settingsSnapshot();const stale=await request(prefix,actors.manager,'/save','POST',body);
    expect(stale.response.status).toBe(409);expect(stale.body).toMatchObject({status:409,data:{code:'PRODUCT_CATEGORY_STYLE_STALE_VERSION',operation:'update',operationId:body.operationId,payloadHash:await themeHash(categoryStyleInput(body).canonical)}});expect(await f.settingsSnapshot()).toEqual(before);expect((await request(prefix,actors.manager,`/receipt/${body.operationId}`)).response.status).toBe(404);
    await f.db.insert(systemDise).values({templateName:'\u00a0CATEGORY\u00a0',type:1,value:'{}'});const rejectedBody=input((await page(prefix)).revision);before=await f.settingsSnapshot();const rejected=await request(prefix,actors.manager,'/save','POST',rejectedBody);
    expect(rejected.response.status).toBe(400);expect(rejected.body).toMatchObject({status:400,data:{code:'PRODUCT_CATEGORY_STYLE_REJECTED',operation:'update',operationId:rejectedBody.operationId,payloadHash:await themeHash(categoryStyleInput(rejectedBody).canonical)}});expect(await f.settingsSnapshot()).toEqual(before);
  });});
  it('keeps actor/hash conflicts, damaged journals, raw parse errors and absent transport bindings outside proof',async()=>{await profiles(async()=>{
    const body=input((await page()).revision);expect((await request('/adminapi',actors.manager,'/save','POST',body)).body.status).toBe(200);let before=await f.settingsSnapshot();
    for(const prefix of['/adminapi','/api/admin']){
      expect((await request(prefix,actors.second,`/receipt/${body.operationId}`)).response.status).toBe(404);
      for(const[actor,value]of[[actors.second,body],[actors.manager,{...body,index:1}]]as const)expect((await request(prefix,actor,'/save','POST',value)).body).toMatchObject({status:400,data:null});
      for(const raw of['{bad',JSON.stringify(body).replace('"index":3','"index":3,"ind\\u0065x":2'),' '.repeat(4097)])expect((await request(prefix,actors.manager,'/save','POST',undefined,raw)).body).toMatchObject({status:400,data:null});
      for(const suffix of['?x=1','?x=1&x=2','/receipt/not-uuid'])expect((await request(prefix,actors.manager,suffix)).body).toMatchObject({status:400,data:null});
    }expect(await f.settingsSnapshot()).toEqual(before);
    await f.db.update(systemLog).set({action:'broken'}).where(eq(systemLog.path,`/config/product-category-style/receipt/${body.operationId}`));before=await f.settingsSnapshot();expect((await request('/adminapi',actors.manager,'/save','POST',body)).body).toMatchObject({status:400,data:null});expect(await f.settingsSnapshot()).toEqual(before);
    const binding=env.HYPERDRIVE_ADMIN;delete (env as Partial<Env>).HYPERDRIVE_ADMIN;try{expect((await request('/api/admin',actors.manager)).body.status).not.toBe(200);}finally{env.HYPERDRIVE_ADMIN=binding;}
  });});
  it('blocks generic mutation of both requested and persisted normalized category identities, retaining ordinary DIY writes',async()=>{await profiles(async()=>{
    for(const patch of[{templateName:'category',type:3},{templateName:'category',type:1},{templateName:'\tCATEGORY\n',type:1},{templateName:'\u00a0category\u00a0',type:2}]){
      await f.db.update(systemDise).set(patch).where(eq(systemDise.id,88));const before=await f.settingsSnapshot();for(const prefix of['/adminapi','/api/admin']){
        expect((await request(prefix,actors.generic,'','POST',{id:88,value:'[]',name:'forged'},undefined,'/dise/save')).body).toMatchObject({status:400,data:null});
        const deleting=await request(prefix,actors.generic,'','DELETE',undefined,undefined,'/dise/del/88');expect(deleting.body).toMatchObject({status:400,data:null});expect(deleting.body.msg).toContain('商品分类样式');
        expect((await request(prefix,actors.generic,'','POST',{id:2,value:'[]',template_name:'category',type:3},undefined,'/dise/save')).body).toMatchObject({status:400,data:null});
      }expect(await f.settingsSnapshot()).toEqual(before);
    }
    expect((await request('/adminapi',actors.generic,'','POST',{id:2,value:'[]',name:'ordinary changed',status:0},undefined,'/dise/save')).body.status).toBe(200);
    expect((await f.db.select().from(systemDise).where(eq(systemDise.id,2)))[0]).toMatchObject({name:'ordinary changed',status:0,isDel:0});
    expect((await request('/api/admin',actors.generic,'','DELETE',undefined,undefined,'/dise/del/2')).body.status).toBe(200);expect((await f.db.select().from(systemDise).where(eq(systemDise.id,2)))[0]).toMatchObject({status:0,isDel:1});
  });});
  it('rolls back initial seed if actual journal INSERT permission is absent without claiming deterministic rejection',async()=>{await profiles(async admin=>{
    await f.db.delete(systemDise).where(eq(systemDise.id,88));const snapshot=await page(),before=await f.settingsSnapshot();await f.exec(`REVOKE INSERT ON system_log FROM "${admin.role}"`);
    const failed=await request('/adminapi',actors.manager,'/save','POST',input(snapshot.revision));expect(failed.body.status).not.toBe(200);expect(failed.body.data?.code).toBeUndefined();expect(await f.settingsSnapshot()).toEqual(before);
  });});
});
