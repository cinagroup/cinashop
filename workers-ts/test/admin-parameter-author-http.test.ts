import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import {eq,sql} from 'drizzle-orm';
import type {AppVariables,Env} from '@/env';
import {createContainerFromDb} from '@/lib/di';
import {systemAdmin,systemRole,systemMenus} from '@/models/schema';
import {AdminParameterAuthorService} from '@/services/admin/AdminParameterAuthorService';
import {parameterActionHash} from '@/services/admin/AdminParameterAuthorInput';
import {isAdminParameterRecoveryRoute,requiredAdminPermission,AdminPermissionService} from '@/services/admin/AdminPermissionService';
import {adminapiRoutes} from '@/routes/adminapi';
import {v1Routes} from '@/routes/v1';
import {errorHandler} from '@/middleware/error';
import {createToken,md5,type TokenType} from '@/utils/jwt';
import {specsActor,seedProductSpecs} from './helpers/adminProductSpecs';
import {createAdminParameterAuthorFixture} from './helpers/adminParameterAuthorFixture';
import type {ParameterAction} from '../../view/common/parameterAuthor';
const wiring=vi.hoisted(()=>({open:vi.fn(),close:vi.fn(async()=>{})}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createAdminDatabaseSession:wiring.open}));
const env={APP_KEY:'owned-parameter-http-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:''} as Env;

describe('parameter author actual dual-prefix Hono/JWT and restricted SQL',()=>{
 let f:Awaited<ReturnType<typeof createAdminParameterAuthorFixture>>,service:AdminParameterAuthorService;
 const app=new Hono<{Bindings:Env;Variables:AppVariables}>();app.onError(errorHandler);
 app.use('*',async(c,next)=>{c.set('container',f.container);await next();});app.route('/adminapi',adminapiRoutes);app.route('/api',v1Routes);
 beforeAll(async()=>{f=await createAdminParameterAuthorFixture();service=new AdminParameterAuthorService(f.container);
  wiring.open.mockImplementation(()=>({container:createContainerFromDb(f.db),close:wiring.close}));vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Parameter HTTP forbids external I/O'));
 },30000);
 beforeEach(async()=>{await f.reset();await seedProductSpecs(f.db);await f.db.insert(systemAdmin).values([
  {id:109,account:'foreign-realm',pwd:'specs-fixture-password',level:0,adminType:4},{id:110,account:'foreign-related',pwd:'specs-fixture-password',level:0,relationId:1}]);
  await f.exec("SELECT setval('public.category_id_seq',1000,false),setval('public.store_product_specs_id_seq',1000,false)");
 });
 afterAll(async()=>{expect(fetch).not.toHaveBeenCalled();vi.restoreAllMocks();await f?.close();},30000);
 async function request(path:string,method='GET',body?:unknown,id=101,options:{type?:TokenType;auth?:string;raw?:string}={}){
  const token=id?(await createToken(id,options.type??'admin',options.auth??md5('specs-fixture-password'),env.APP_KEY)).token:'';
  return f.asAdmin(async()=>{const response=await app.request(path,{method,headers:{...(token?{'Authori-zation':`Bearer ${token}`} : {}),'Content-Type':'application/json'},
   body:options.raw??(body===undefined?undefined:JSON.stringify(body))},env);
   return {status:response.status,headers:response.headers,body:await response.json() as {status:number;msg:string;data:any}};
  });
 }
 async function intent(actor_id=101):Promise<ParameterAction>{
  const source=await f.asAdmin(()=>service.catalog(new URLSearchParams(),specsActor(100)));
  const a:ParameterAction={operation_id:crypto.randomUUID(),actor_id,operation:'update',target_id:11,revision:source.revision,payload:{name:'HTTP编辑',sort:'9',mode:'preserve'},payload_hash:''};a.payload_hash=parameterActionHash(a);return a;
 }
 async function snapshot(){const result:Record<string,unknown>={};for(const table of ['category','store_product_specs','store_product','store_product_relation','system_admin','system_role','system_log','admin_parameter_operation'])result[table]=Array.from(await f.db.execute(sql.raw(`SELECT * FROM public.${table} ORDER BY 1`)));return result;}
 async function unchanged(run:()=>Promise<unknown>){const before=await snapshot();try{return await run();}finally{expect(await snapshot()).toEqual(before);}}
 for(const prefix of ['/adminapi','/api/admin']){
  const base=prefix+'/product/specs/author';
  it(prefix+' serves complete platform directory including disabled rows with private cache headers and actual session factory',()=>unchanged(async()=>{
   const result=await request(base+'/catalog','GET',undefined,105);expect(result.body.status,result.body.msg).toBe(200);expect(result.headers.get('Cache-Control')).toBe('private, no-store');
   expect(result.body.data).toMatchObject({count:3,write_ready:true,can_create:true,list:[{id:11,name:'易碎参数'},{id:10,name:'标准参数'},{id:12,name:'隐藏参数',is_show:0}]});
   expect(JSON.stringify(result.body)).not.toMatch(/rowVersion|供应商参数|异常平台|pwd|account/);expect(wiring.open).toHaveBeenCalled();expect(wiring.close).toHaveBeenCalled();
  }));
  it(prefix+' persists and replays one original parameter UUID with one existing audit',async()=>{
   const a=await intent(),first=await request(base+'/commit','POST',a);expect(first.body.status,first.body.msg).toBe(200);expect(first.body.data.state).toBe('committed');
   await unchanged(async()=>{expect((await request(base+'/commit','POST',a)).body.data).toEqual(first.body.data);expect((await request(base+'/receipt/'+a.operation_id)).body.data).toEqual(first.body.data);});
  });
  it(prefix+' retains original owner receipt/resolve after all role grants disappear without new commit authority',async()=>{
   const a=await intent();await f.db.update(systemRole).set({rules:''}).where(eq(systemRole.id,1));
   await unchanged(async()=>{expect((await request(base+'/commit','POST',a)).body.status).not.toBe(200);expect((await request(base+'/catalog')).body.status).not.toBe(200);expect((await request(base+'/receipt/'+a.operation_id)).body.status).toBe(404);});
   const sealed=await request(base+'/resolve','POST',a);expect(sealed.body.status,sealed.body.msg).toBe(200);expect(sealed.body.data.state).toBe('not_applied');
   await unchanged(async()=>{expect((await request(base+'/receipt/'+a.operation_id)).body.data).toEqual(sealed.body.data);expect((await request(base+'/receipt/'+a.operation_id,'GET',undefined,100)).body.status).toBe(404);expect((await request(base+'/resolve','POST',a,100)).body.status).not.toBe(200);});
   await f.db.update(systemRole).set({rules:'product.manage'}).where(eq(systemRole.id,1));await unchanged(async()=>expect((await request(base+'/commit','POST',a)).body.status).not.toBe(200));
  });
  it(prefix+' keeps exact1381 page grant read-only and old API writer grant independent',async()=>{
   await unchanged(async()=>{expect((await request(base+'/catalog','GET',undefined,105)).body.status).toBe(200);expect((await request(base+'/commit','POST',await intent(105),105)).body.status).toBe(400011);});
   const written=await request(base+'/commit','POST',await intent(104),104);expect(written.body.status,written.body.msg).toBe(200);
  });
  it(prefix+' accepts the complete legal100-row Unicode/C0 body beyond the old64KiB budget without truncation',async()=>{
   const a=await intent();a.operation='create';a.target_id=0;a.payload={name:'😀'.repeat(255),sort:'0',mode:'replace',specs:Array.from({length:100},()=>({name:'\u0001'.repeat(255),value:'😀'.repeat(255),sort:'0',status:'1'}))};a.payload_hash=parameterActionHash(a);expect(new TextEncoder().encode(JSON.stringify(a)).length).toBeGreaterThan(65536);const result=await request(base+'/commit','POST',a);expect(result.body.status,result.body.msg).toBe(200);expect(result.body.data.result).toMatchObject({id:1000,created:1,count:4});
  });
  it(prefix+' rejects nonwriter roles, unexpected queries, bounded/malformed JSON and hidden author fields',async()=>{
   for(const id of [102,103,105,106,107])await unchanged(async()=>expect((await request(base+'/commit','POST',await intent(id),id)).body.status).not.toBe(200));
   for(const q of ['?page=1','?id=3&id=6'])await unchanged(async()=>expect((await request(base+'/catalog'+q)).body.status).not.toBe(200));
   for(const raw of ['[1]','{bad',' '.repeat(524289)])await unchanged(async()=>expect((await request(base+'/commit','POST',undefined,101,{raw})).body.status).not.toBe(200));
   const a=await intent();await unchanged(async()=>expect((await request(base+'/commit','POST',{...a,payload:{...a.payload,status:0}})).body.status).not.toBe(200));
  });
 }
 it('rejects anonymous/App tokens, foreign realms and changed credentials even on owner routes',async()=>{
  for(const [id,options]of [[0,{}],[101,{type:'api'}],[109,{}],[110,{}],[101,{auth:md5('changed')}]]as const){const a=await intent(id||101);
   await unchanged(async()=>{expect((await request('/adminapi/product/specs/author/catalog','GET',undefined,id,options)).body.status).not.toBe(200);expect((await request('/adminapi/product/specs/author/resolve','POST',a,id,options)).body.status).not.toBe(200);});
  }
 });
 it('does not widen1381 page tuple or either numeric permission resolver',async()=>{
  const original={authType:1,apiUrl:'',methods:'',menuPath:'/admin/product/specs',uniqueAuth:'admin-storeProduct-specs'};
  for(const patch of [{authType:2,apiUrl:'product/specs/author/commit',methods:'POST'},{menuPath:'/admin/product/specs/other'},{uniqueAuth:'product.manage'},{methods:'GET'}]){
   await f.db.update(systemMenus).set({...original,...patch}).where(eq(systemMenus.id,1381));await unchanged(async()=>{
    expect((await request('/adminapi/product/specs/author/catalog','GET',undefined,105)).body.status).toBe(400011);
    const permissions=new AdminPermissionService(f.container);expect(await f.asAdmin(()=>permissions.resolveRulePermissionKeys('1381'))).toEqual([]);expect(await f.asAdmin(()=>permissions.resolveManyRulePermissionKeys(['1381']))).toEqual([[]]);
   });
  }
 });
 it('has exact registered author verbs and owner recovery without broad parameter namespace exemption',()=>{
  for(const prefix of ['/adminapi','/api/admin']){
   expect(requiredAdminPermission('GET',prefix+'/product/specs/author/catalog')).toBe('product.view');expect(requiredAdminPermission('POST',prefix+'/product/specs/author/commit')).toBe('product.manage');
   for(const [method,path]of [['GET','receipt/:operationId'],['HEAD','receipt/40000000-0000-4000-8000-000000000001'],['POST','resolve']]){expect(isAdminParameterRecoveryRoute(method!,prefix+'/product/specs/author/'+path)).toBe(true);expect(requiredAdminPermission(method!,prefix+'/product/specs/author/'+path)).toBeNull();}
   for(const [method,path]of [['POST','receipt/x'],['GET','resolve'],['POST','catalog'],['PUT','commit'],['POST','resolve/extra'],['GET','receipt/x/extra']]){expect(isAdminParameterRecoveryRoute(method!,prefix+'/product/specs/author/'+path)).toBe(false);expect(requiredAdminPermission(method!,prefix+'/product/specs/author/'+path)).toBeNull();}
  }
 });
});
