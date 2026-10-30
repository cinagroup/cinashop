import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import {createHash} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import type {AppVariables,Env} from '@/env';
import {createContainerFromDb} from '@/lib/di';
import {systemAdmin,systemRole,systemMenus,storeProductWords} from '@/models/schema';
import {AdminHotwordAuthorService} from '@/services/admin/AdminHotwordAuthorService';
import {hotwordActionHash} from '@/services/admin/AdminHotwordAuthorInput';
import {isAdminHotwordRecoveryRoute,requiredAdminPermission,AdminPermissionService} from '@/services/admin/AdminPermissionService';
import {adminapiRoutes} from '@/routes/adminapi';
import {v1Routes} from '@/routes/v1';
import {errorHandler} from '@/middleware/error';
import {createToken,md5,type TokenType} from '@/utils/jwt';
import {createAdminHotwordAuthorFixture,seedHotwords,hotwordActor,hotwordValues} from './helpers/adminHotwordAuthorFixture';
import type {HotwordAction,HotwordOperation} from '../../view/common/hotwordAuthor';
const wiring=vi.hoisted(()=>({open:vi.fn(),close:vi.fn(async()=>{})}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createAdminDatabaseSession:wiring.open}));
const env={APP_KEY:'owned-hotword-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:''} as Env;
const password='hotword-fixture-password';

describe('hotword author real dual-prefix Hono/JWT and restricted SQL',()=>{
 let f:Awaited<ReturnType<typeof createAdminHotwordAuthorFixture>>,service:AdminHotwordAuthorService;
 const app=new Hono<{Bindings:Env;Variables:AppVariables}>();app.onError(errorHandler);
 app.use('*',async(c,next)=>{c.set('container',f.container);await next();});app.route('/adminapi',adminapiRoutes);app.route('/api',v1Routes);
 beforeAll(async()=>{f=await createAdminHotwordAuthorFixture();service=new AdminHotwordAuthorService(f.container,env);
  wiring.open.mockImplementation(()=>({container:createContainerFromDb(f.db),close:wiring.close}));
  vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Hotword HTTP must not call a provider'));
 },30000);
 beforeEach(async()=>{await f.reset();await seedHotwords(f.db);await f.db.insert(systemAdmin).values([
  {id:109,account:'hotword-foreign-realm',pwd:password,level:0,adminType:4},
  {id:110,account:'hotword-foreign-relation',pwd:password,level:0,relationId:9},
 ]);wiring.open.mockClear();wiring.close.mockClear();});
 afterAll(async()=>{expect(fetch).not.toHaveBeenCalled();vi.restoreAllMocks();await f?.close();},30000);
 async function request(path:string,method='GET',body?:unknown,id=101,options:{type?:TokenType;auth?:string;raw?:string;issuedAt?:number;token?:string}={}){
  const token=options.token??(id?(await createToken(id,options.type??'admin',options.auth??md5(password),env.APP_KEY,'cinashop',options.issuedAt)).token:'');
  return f.asAdmin(async()=>{const response=await app.request(path,{method,headers:{...(token?{'Authori-zation':`Bearer ${token}`} : {}),'Content-Type':'application/json'},body:options.raw??(body===undefined?undefined:JSON.stringify(body))},env);
   const text=await response.text();let parsed:{status:number;msg:string;data:any};try{parsed=JSON.parse(text) as typeof parsed;}catch{parsed={status:response.status,msg:text,data:null};}
   return {status:response.status,headers:response.headers,body:parsed};
  });
 }
 async function intent(operation:HotwordOperation='update',target_id=10,payload:Record<string,unknown>=hotwordValues({name:'HTTP新词'}),actor_id=101):Promise<HotwordAction>{
  const source=await f.asAdmin(()=>service.catalog(new URLSearchParams(),hotwordActor(100)));
  const a:HotwordAction={operation_id:crypto.randomUUID(),actor_id,operation,target_id,revision:source.revision,payload,payload_hash:''};a.payload_hash=hotwordActionHash(a);return a;
 }
 async function snapshot(){const result:Record<string,unknown>={};for(const table of['store_product_words','system_admin','system_role','system_menus','system_attachment','system_attachment_category','system_log','admin_hotword_operation'])result[table]=Array.from(await f.db.execute(sql.raw(`SELECT * FROM public.${table} ORDER BY 1`)));
  result.sequences=Array.from(await f.db.execute(sql`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`));return result;
 }
 async function unchanged<T>(work:()=>Promise<T>):Promise<T>{const before=await snapshot();try{return await work();}finally{expect(await snapshot()).toEqual(before);}}
 for(const prefix of['/adminapi','/api/admin']){
  const base=prefix+'/product/words/author';
  it(prefix+' reads every platform nondeleted row including hidden and historical flags with real session/cache boundaries',()=>unchanged(async()=>{
   const result=await request(base+'/catalog','GET',undefined,102);expect(result.status).toBe(200);expect(result.body.status,result.body.msg).toBe(200);
   expect(result.headers.get('Cache-Control')).toBe('private, no-store');expect(result.headers.get('Pragma')).toBe('no-cache');
   expect(result.body.data).toMatchObject({count:3,write_ready:true,can_create:true});expect(result.body.data.list.map((row:{id:number})=>row.id)).toEqual([10,12,11]);
   const history=result.body.data.list.find((row:{id:number})=>row.id===11);expect([...history.name]).toHaveLength(128);expect(history).toMatchObject({sort:-9,is_show:7,is_search:5,is_hot:3,add_time:-8});
   expect(Object.keys(history).sort()).toEqual(['id','type','relation_id','name','color','bg_color','border_color','icon','sort','is_search','is_show','is_hot','is_del','add_time','preview'].sort());
   expect(result.body.data.list.some((row:{id:number})=>[20,21,30].includes(row.id))).toBe(false);expect(JSON.stringify(result.body)).not.toMatch(/rowVersion|pwd|account|attachments\//u);expect(wiring.open).toHaveBeenCalled();expect(wiring.close).toHaveBeenCalled();
  }));
  it(prefix+' executes four exact operations and replays the original UUID before stale CAS without a second audit',async()=>{
   const create=await intent('create',0,hotwordValues({name:' HTTP新热词 ',icon:'/api/assets/1'}));const made=await request(base+'/commit','POST',create);expect(made.body.status,made.body.msg).toBe(200);expect(made.body.data).toMatchObject({state:'committed',operation:'create',result:{created:1,updated:0,count:4}});const id=made.body.data.result.id;
   expect((await f.db.select().from(storeProductWords).where(eq(storeProductWords.id,id)))[0]).toMatchObject({name:'HTTP新热词',icon:'/api/assets/1',type:0,relationId:0,isDel:0});
   await unchanged(async()=>{expect((await request(base+'/commit','POST',create)).body.data).toEqual(made.body.data);expect((await request(base+'/receipt/'+create.operation_id)).body.data).toEqual(made.body.data);});
   const update=await intent('update',id,hotwordValues({name:'HTTP编辑后',color:'#abcdef',sort:'999',is_search:'0',is_show:'1'}));expect((await request(base+'/commit','POST',update)).body.status).toBe(200);
   const show=await intent('show',id,{is_show:0});const hidden=await request(base+'/commit','POST',show);expect(hidden.body.status,hidden.body.msg).toBe(200);expect(hidden.body.data.result.updated).toBe(1);
   const deleted=await request(base+'/commit','POST',await intent('delete',id,{}));expect(deleted.body.status,deleted.body.msg).toBe(200);expect(deleted.body.data.result.count).toBe(3);
   expect((await f.db.select().from(storeProductWords).where(eq(storeProductWords.id,id)))[0]).toMatchObject({name:'HTTP编辑后',color:'#abcdef',sort:999,isDel:1,isShow:0,isHot:0});
   await unchanged(async()=>expect((await request(base+'/receipt/'+create.operation_id)).body.data).toEqual(made.body.data));
  });
  it(prefix+' keeps receipt and explicit same-owner seal available after grant withdrawal while new commit stays denied',async()=>{
   const committed=await intent(),first=await request(base+'/commit','POST',committed);expect(first.body.status,first.body.msg).toBe(200);const pending=await intent('show',10,{is_show:0});
   await f.db.update(systemRole).set({rules:''}).where(eq(systemRole.id,1));
   await unchanged(async()=>{expect((await request(base+'/catalog')).body.status).not.toBe(200);expect((await request(base+'/commit','POST',pending)).body.status).not.toBe(200);expect((await request(base+'/receipt/'+committed.operation_id)).body.data).toEqual(first.body.data);expect((await request(base+'/receipt/'+pending.operation_id)).body.status).toBe(404);});
   const sealed=await request(base+'/resolve','POST',pending);expect(sealed.body.status,sealed.body.msg).toBe(200);expect(sealed.body.data).toMatchObject({state:'not_applied',result:{id:10,created:0,updated:0,count:0,revision:pending.revision}});
   await unchanged(async()=>{expect((await request(base+'/receipt/'+pending.operation_id)).body.data).toEqual(sealed.body.data);expect((await request(base+'/receipt/'+committed.operation_id,'GET',undefined,100)).body.status).toBe(404);expect((await request(base+'/resolve','POST',pending,100)).body.status).not.toBe(200);});
   await f.db.update(systemRole).set({rules:'product.manage'}).where(eq(systemRole.id,1));await unchanged(async()=>expect((await request(base+'/commit','POST',pending)).body.status).not.toBe(200));
  });
  it(prefix+' rejects foreign/deleted target IDs and private-source staleness without changing any scope',async()=>{
   for(const id of[20,21,30,999]){const a=await intent('show',id,{is_show:0});await unchanged(async()=>expect((await request(base+'/commit','POST',a)).body.status).toBe(404));}
   const a=await intent();await f.db.update(storeProductWords).set({isHot:9}).where(eq(storeProductWords.id,20));await unchanged(async()=>expect((await request(base+'/commit','POST',a)).body.status).toBe(409));
  });
  it(prefix+' refuses unexpected or duplicate author query and unknown HTTP verbs without falling into legacy:id',async()=>{
   for(const q of['?page=1','?id=3&id=6','?url=https://evil.test','?type=2'])await unchanged(async()=>expect((await request(base+'/catalog'+q)).body.status).not.toBe(200));
   const a=await intent();for(const suffix of['/commit?x=1','/resolve?x=1'])await unchanged(async()=>expect((await request(base+suffix,'POST',a)).body.status).not.toBe(200));
   for(const [method,path]of[['POST','catalog'],['PUT','commit'],['GET','resolve'],['GET','receipt/x/extra']])await unchanged(async()=>expect((await request(base+'/'+path,method)).body.status).not.toBe(200));
  });
  it(prefix+' enforces real32KiB JSON body and16KiB raw payload for both mutation and resolve',async()=>{
   const a=await intent();const serialized=JSON.stringify(a),oversized=serialized+' '.repeat(32769-Buffer.byteLength(serialized));expect(Buffer.byteLength(oversized)).toBe(32769);
   for(const endpoint of['commit','resolve'])for(const raw of['[1]','{bad',oversized])await unchanged(async()=>expect((await request(base+'/'+endpoint,'POST',undefined,101,{raw})).body.status).not.toBe(200));
   const extra={...a,payload:{...a.payload,is_hot:1}};await unchanged(async()=>expect((await request(base+'/commit','POST',extra)).body.status).not.toBe(200));
   const wrongHash={...a,payload_hash:'f'.repeat(64)};await unchanged(async()=>expect((await request(base+'/commit','POST',wrongHash)).body.status).not.toBe(200));
   const wide={...a,payload:hotwordValues({name:'🧭'.repeat(4096),icon:''})};wide.payload_hash=createHash('sha256').update(JSON.stringify({domain:'product-hotword-author-v1',actor_id:wide.actor_id,operation_id:wide.operation_id,operation:wide.operation,target_id:wide.target_id,revision:wide.revision,payload:wide.payload})).digest('hex');expect(Buffer.byteLength(JSON.stringify(wide.payload))).toBeGreaterThan(16*1024);expect(Buffer.byteLength(JSON.stringify(wide))).toBeLessThan(32*1024);await unchanged(async()=>expect((await request(base+'/resolve','POST',wide)).body.status).not.toBe(200));
  });
  it(prefix+' grants gallery GET only to product.manage and keeps view-only author read distinct',async()=>{
   for(const endpoint of['attachments/categories','attachments/options']){
    const result=await unchanged(()=>request(base+'/'+endpoint));expect(result.status).toBe(200);expect(result.body.status,result.body.msg).toBe(200);expect(result.headers.get('Cache-Control')).toBe('private, no-store');
    for(const id of[102,103])await unchanged(async()=>expect((await request(base+'/'+endpoint,'GET',undefined,id)).body.status).not.toBe(200));
   }
   await unchanged(async()=>{expect((await request(base+'/catalog','GET',undefined,102)).body.status).toBe(200);expect((await request(base+'/catalog','GET',undefined,103)).body.status).not.toBe(200);expect((await request(base+'/commit','POST',await intent('show',10,{is_show:0},102),102)).body.status).not.toBe(200);});
  });
 }
 it('rejects guest/App/forged/expired JWT and foreign realm or changed credentials even on owner routes',async()=>{
  const invalid:[number,{type?:TokenType;auth?:string;issuedAt?:number;token?:string}][]=[[0,{}],[101,{type:'api'}],[101,{token:'forged.invalid.token'}],[101,{issuedAt:1}],[109,{}],[110,{}],[101,{auth:md5('changed')}]];
  for(const[id,options]of invalid){const a=await intent('show',10,{is_show:0},id||101);await unchanged(async()=>{expect((await request('/adminapi/product/words/author/catalog','GET',undefined,id,options)).body.status).not.toBe(200);expect((await request('/adminapi/product/words/author/resolve','POST',a,id,options)).body.status).not.toBe(200);});}
 });
 it('checks owner password/status again after a successful command instead of treating UUID as authorization',async()=>{
  const a=await intent(),first=await request('/adminapi/product/words/author/commit','POST',a);expect(first.body.status).toBe(200);
  await f.db.update(systemAdmin).set({pwd:'changed-current-hash'}).where(eq(systemAdmin.id,101));
  await unchanged(async()=>{expect((await request('/adminapi/product/words/author/receipt/'+a.operation_id)).body.status).not.toBe(200);expect((await request('/adminapi/product/words/author/resolve','POST',a)).body.status).not.toBe(200);});
  await f.db.update(systemAdmin).set({pwd:password,status:0}).where(eq(systemAdmin.id,101));await unchanged(async()=>expect((await request('/adminapi/product/words/author/receipt/'+a.operation_id)).body.status).not.toBe(200));
 });
 it('uses actual numeric API mapping rather than inventing a hotWords page seed grant',async()=>{
  const permissions=new AdminPermissionService(f.container),resolved=await f.asAdmin(()=>permissions.resolveRulePermissionKeys('1501'));
  // Current generic POST product/words/<id> binding supplies product.manage;
  // the new author requests that same capability, not an invented page grant.
  expect(resolved).toContain('product.manage');expect(resolved).toContain('product.view');
  const a=await intent('show',10,{is_show:0},104),written=await request('/adminapi/product/words/author/commit','POST',a,104);expect(written.body.status,written.body.msg).toBe(200);
 });
 it('does not turn a page-shaped numeric row or copied manage label into author write permission',async()=>{
  await f.db.update(systemMenus).set({authType:1,menuPath:'/admin/product/hotWords',uniqueAuth:'product.manage',apiUrl:'',methods:''}).where(eq(systemMenus.id,1501));
  const permissions=new AdminPermissionService(f.container),resolved=await f.asAdmin(()=>permissions.resolveRulePermissionKeys('1501'));expect(resolved).not.toContain('product.manage');
  await unchanged(async()=>{expect((await request('/adminapi/product/words/author/commit','POST',await intent('show',10,{is_show:0},104),104)).body.status).not.toBe(200);expect((await request('/adminapi/product/words/author/attachments/options','GET',undefined,104)).body.status).not.toBe(200);});
 });
 it('keeps exact six registered verbs and owner recovery exemptions without exempting the whole namespace',()=>{
  for(const prefix of['/adminapi','/api/admin']){const base=prefix+'/product/words/author';expect(requiredAdminPermission('GET',base+'/catalog')).toBe('product.view');expect(requiredAdminPermission('POST',base+'/commit')).toBe('product.manage');for(const path of['categories','options'])expect(requiredAdminPermission('GET',base+'/attachments/'+path)).toBe('product.manage');
   for(const[method,path]of[['GET','receipt/:operationId'],['HEAD','receipt/40000000-0000-4000-8000-000000000001'],['POST','resolve']]){expect(isAdminHotwordRecoveryRoute(method!,base+'/'+path)).toBe(true);expect(requiredAdminPermission(method!,base+'/'+path)).toBeNull();}
   for(const[method,path]of[['POST','receipt/x'],['GET','resolve'],['POST','catalog'],['PUT','commit'],['POST','resolve/extra'],['GET','receipt/x/extra']])expect(isAdminHotwordRecoveryRoute(method!,base+'/'+path)).toBe(false);
  }
 });
});
