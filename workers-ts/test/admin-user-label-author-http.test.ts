import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import {eq,sql} from 'drizzle-orm';
import type {AppVariables,Env,OrderMessage} from '@/env';
import {createContainerFromDb} from '@/lib/di';
import {systemAdmin,systemRole,userLabel,legacyCategory,userLabelRelation,systemConfig} from '@/models/schema';
import {AdminUserLabelAuthorService,labelDigest} from '@/services/admin/AdminUserLabelAuthorService';
import {requiredAdminPermission,isAdminUserLabelRecoveryRoute} from '@/services/admin/AdminPermissionService';
import {adminapiRoutes} from '@/routes/adminapi';
import {v1Routes} from '@/routes/v1';
import {errorHandler} from '@/middleware/error';
import {createToken,md5,type TokenType} from '@/utils/jwt';
import {labelCanonical,type LabelAction,type LabelOperation} from '../../view/common/labelAuthor';
import {createAdminLabelFixture} from './helpers/adminLabelFixture';

// Only the independent connection factory and Queue/HTTP ports are replaced.
// JWT, route permission, live authority, SQL, immutable events and controllers
// are the production implementations under the fixture's restricted Admin.
const wiring=vi.hoisted(()=>({open:vi.fn(),close:vi.fn(async()=>{})}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createAdminDatabaseSession:wiring.open}));
const pwd='owned-label-http-password';
const sent:OrderMessage[]=[];
const queueResponse:QueueSendResponse={metadata:{metrics:{backlogCount:0,backlogBytes:0}}};
const send=vi.fn(async(message:OrderMessage):Promise<QueueSendResponse>=>{sent.push(structuredClone(message));return queueResponse;});
const env={APP_KEY:'owned-label-http-jwt-and-queue-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',
 WECHAT_WORK_EXTERNAL_CONTACT_SECRET:'controlled-label-http-secret',ORDER_QUEUE:{send}} as unknown as Env;
const actor=(id=1)=>({id,authVersion:md5(pwd),expiresAt:Math.floor(Date.now()/1000)+3600});
const label=(patch:Record<string,unknown>={})=>({name:'原标签',label_cate:10,color:'old-color',sort:-9,status:1,...patch});
type Reply={status:number;headers:Headers;body:{status:number;data:any;msg:string}};

describe('ordinary user-label author actual dual-prefix Hono/JWT and restricted SQL',()=>{
 let f:Awaited<ReturnType<typeof createAdminLabelFixture>>,s:AdminUserLabelAuthorService;
 const app=new Hono<{Bindings:Env;Variables:AppVariables}>();
 app.onError(errorHandler);
 app.use('*',async(c,next)=>{c.set('container',f.container);await next();});
 app.route('/adminapi',adminapiRoutes);app.route('/api',v1Routes);
 beforeAll(async()=>{
  f=await createAdminLabelFixture();s=new AdminUserLabelAuthorService(f.container,env);
  wiring.open.mockImplementation(()=>({container:createContainerFromDb(f.db),close:wiring.close}));
  vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Local Hono author must not make provider HTTP calls'));
 },30000);
 beforeEach(async()=>{
  await f.reset();send.mockClear();sent.length=0;wiring.open.mockClear();wiring.close.mockClear();
  send.mockImplementation(async(message:OrderMessage)=>{sent.push(structuredClone(message));return queueResponse;});
  await f.db.insert(systemRole).values([{id:1,rules:'label.view'},{id:2,rules:'label.manage'},{id:3,rules:'attachment.manage'}]);
  await f.db.insert(systemAdmin).values([{id:1,account:'root',pwd,level:0},{id:2,account:'reader',pwd,level:1,roles:'1'},
   {id:3,account:'writer',pwd,level:1,roles:'2'},{id:4,account:'unrelated',pwd,level:1,roles:'3'},
   {id:5,account:'supplier',pwd,level:0,adminType:4},{id:6,account:'foreign',pwd,level:0,relationId:7}]);
  await f.db.insert(legacyCategory).values([{id:10,name:'原分类',sort:-7,other:'et-known-group',integralMin:9},
   {id:11,name:'目标分类',sort:10},{id:12,name:'外部分类',ownerId:7}]);
  await f.db.insert(userLabel).values([{id:20,name:'原标签',labelCate:10,color:'old-color',sort:-9,status:1,tagId:'et-known-tag',addTime:7},
   {id:21,name:'停用标签',labelCate:11,color:'#336699',status:0,sort:3},{id:22,name:'外部标签',labelCate:12,type:1,relationId:7}]);
  await f.exec("SELECT setval('public.category_id_seq',100,false);SELECT setval('public.user_label_id_seq',200,false)");
 });
 afterAll(async()=>{expect(fetch).not.toHaveBeenCalled();vi.restoreAllMocks();await f?.close();},30000);
 const catalog=(id=1)=>f.asAdmin(()=>s.catalog(new URLSearchParams(),actor(id)));
 async function intent(operation:LabelOperation,target_id=20,payload:Record<string,unknown>={},id=3):Promise<LabelAction>{
  const a:LabelAction={operation_id:crypto.randomUUID(),actor_id:id,operation,target_id,revision:(await catalog()).revision,payload,payload_hash:''};
  a.payload_hash=labelDigest(labelCanonical(a));return a;
 }
 async function request(path:string,method='GET',body?:unknown,id=1,options:{auth?:string;type?:TokenType;raw?:string;token?:string}={}):Promise<Reply>{
  const token=options.token??(id?(await createToken(id,options.type??'admin',options.auth??md5(pwd),env.APP_KEY)).token:'');
  return f.asAdmin(async()=>{const r=await app.request(path,{method,headers:{...(token?{'Authori-zation':`Bearer ${token}`} : {}),'Content-Type':'application/json'},
   body:options.raw??(body===undefined?undefined:JSON.stringify(body))},env);
   return{status:r.status,headers:r.headers,body:await r.json() as Reply['body']};});
 }
 async function snapshot(){
  const names=['category','user_label','user_label_relation','system_admin','system_role','system_config','store_promotions','store_order','store_product','admin_label_operation'];
  const rows:Record<string,unknown>={};for(const name of names)rows[name]=Array.from(await f.db.execute(sql.raw(`SELECT * FROM public."${name}" ORDER BY 1`)),r=>({...r}));
  return{rows,sequences:Array.from(await f.db.execute(sql`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`),r=>({...r}))};
 }
 async function unchanged(run:()=>Promise<unknown>){const before=await snapshot();try{return await run();}finally{expect(await snapshot()).toEqual(before);}}

 for(const prefix of ['/adminapi','/api/admin']){
  it(prefix+' authenticates real JWT, installs the independent Admin connection and reads complete readonly platform rows',async()=>{
   await unchanged(async()=>{
    const r=await request(prefix+'/user_label/catalog','GET',undefined,2);
    expect(r.body.status).toBe(200);expect(r.headers.get('cache-control')).toContain('no-store');
    expect(r.body.data).toMatchObject({write_ready:true,sync_configured:false,sync_busy:false,sync_pending:null});
    expect(r.body.data.categories.map((r:any)=>r.id)).toEqual([11,10]);expect(r.body.data.labels.map((r:any)=>r.id)).toEqual([21,20]);
    expect(r.body.data.categories[1]).toMatchObject({other:'et-known-group',sort:-7,integralMin:9});
    expect(r.body.data.labels[1]).toMatchObject({tagId:'et-known-tag',color:'old-color',sort:-9});
    expect(wiring.open).toHaveBeenCalledTimes(1);expect(wiring.close).toHaveBeenCalledTimes(1);
   });
  });
  it(prefix+' commits modern category/label actions, replays exact UUID before version checks and reads the owner receipt',async()=>{
   const category=await intent('category_create',0,{name:'新增分类',sort:0}),madeCategory=await request(prefix+'/user_label/author/commit','POST',category,3);
   expect(madeCategory.body.status).toBe(200);expect(madeCategory.body.data.result).toMatchObject({id:100,created:1,updated:0});
   const a=await intent('label_create',0,{name:'新增标签',label_cate:100,color:'#123456',sort:0,status:1}),r=await request(prefix+'/user_label/author/commit','POST',a,3);
   expect(r.body.status).toBe(200);expect(r.body.data).toMatchObject({operation_id:a.operation_id,actor_id:3,state:'committed',step:0,result:{id:200,created:1,updated:0}});
   await f.db.update(userLabel).set({sort:8}).where(eq(userLabel.id,21));
   await unchanged(async()=>{
    expect((await request(prefix+'/user_label/author/commit','POST',a,3)).body.data).toEqual(r.body.data);
    expect((await request(prefix+'/user_label/author/receipt/'+a.operation_id,'GET',undefined,3)).body.data).toEqual(r.body.data);
   });
   expect(send).not.toHaveBeenCalled();
  });
  it(prefix+' preserves the active PHP empty All filter, category selection, category form action and exact two-field forms',async()=>{
   await unchanged(async()=>{
    const all=await request(prefix+'/user/user_label?page=1&limit=10&label_cate=','GET',undefined,2);
    expect(all.body.status).toBe(200);expect(all.body.data.count).toBe(2);
    expect(all.body.data.list.map((r:any)=>r.id)).toEqual([21,20]);
    const filtered=await request(prefix+'/user/user_label?label_cate=10&label_name='+encodeURIComponent('原'),'GET',undefined,2);
    expect(filtered.body.data.list).toMatchObject([{id:20,label_name:'原标签',label_cate:10}]);
    const form=await request(prefix+'/user/user_label/add/0?label_cate=11','GET',undefined,2);
    expect(form.body.status).toBe(200);expect(form.body.data.rules.map((r:any)=>r.field)).toEqual(['label_cate','label_name']);
    expect(form.body.data.rules.find((r:any)=>r.field==='label_cate').value).toBe(11);
    expect(form.body.data.rules.some((r:any)=>r.type==='frameImage')).toBe(false);
    const edit=await request(prefix+'/user/user_label_cate/10/edit','GET',undefined,2);
    expect(edit.body.status).toBe(200);expect(edit.body.data.action).toMatch(/user\/user_label_cate\/10$/);
    expect(edit.body.data.method.toUpperCase()).toBe('PUT');expect(edit.body.data.rules.map((r:any)=>r.field)).toEqual(['name','sort']);
   });
  });
  it(prefix+' retains the existing modern save id response and the original two-field label/category write contracts',async()=>{
   const[old]=await f.db.select().from(userLabel).where(eq(userLabel.id,20));
   const r=await request(prefix+'/user_label/save','POST',{id:20,name:'现代名称'},3);
   expect(r.body.status).toBe(200);expect(r.body.data).toEqual({id:20});
   expect((await f.db.select().from(userLabel).where(eq(userLabel.id,20)))[0]).toEqual({...old,name:'现代名称'});
   expect((await request(prefix+'/user/user_label/save','POST',{id:20,label_name:'原表单名称',label_cate:'11'},3)).body.status).toBe(200);
   const[after]=await f.db.select().from(userLabel).where(eq(userLabel.id,20));expect(after).toEqual({...old,name:'原表单名称',labelCate:11});
   expect((await request(prefix+'/user/user_label_cate','POST',{name:'新增表单分类',sort:'0'},3)).body.status).toBe(200);
   expect((await request(prefix+'/user/user_label_cate/100','PUT',{name:'改分类',sort:'1'},3)).body.status).toBe(200);
   expect((await request(prefix+'/user/user_label_cate/100','DELETE',{},3)).body.status).toBe(200);
   expect((await request(prefix+'/user/user_label/del/20','DELETE',{},3)).body.status).toBe(200);
   expect((await f.db.select().from(userLabel).where(eq(userLabel.id,20))).length).toBe(0);
  });
  it(prefix+' denies guest, API tokens, stale password, reader writes, foreign realms and unrelated capabilities without effects',async()=>{
   const a=await intent('label_update',20,label({name:'无权写入'}));
   await unchanged(async()=>{
    for(const [id,options]of [[0,{}],[1,{type:'api' as const}],[1,{auth:'0'.repeat(32)}],[4,{}],[5,{}],[6,{}]] as const){
     const r=await request(prefix+'/user_label/catalog','GET',undefined,id,options);expect(r.body.status).not.toBe(200);
    }
    expect((await request(prefix+'/user_label/author/commit','POST',a,2)).body.status).not.toBe(200);
    expect((await request(prefix+'/user_label/author/commit','POST',{...a,actor_id:2},3)).body.status).not.toBe(200);
   });expect(send).not.toHaveBeenCalled();
  });
  it(prefix+' allows revoked same-owner receipt/recovery but not a foreign owner or new writes',async()=>{
   const a=await intent('label_update',20,label({name:'已回执'})),r=await request(prefix+'/user_label/author/commit','POST',a,3);
   expect(r.body.status).toBe(200);const missing=await intent('label_update',20,label({name:'未发送'}));
   await f.db.update(systemRole).set({rules:''}).where(eq(systemRole.id,2));
   await unchanged(async()=>{
    expect((await request(prefix+'/user_label/author/receipt/'+a.operation_id,'GET',undefined,3)).body.data).toEqual(r.body.data);
    expect((await request(prefix+'/user_label/author/receipt/'+a.operation_id,'GET',undefined,2)).body.status).not.toBe(200);
    expect((await request(prefix+'/user_label/author/commit','POST',missing,3)).body.status).not.toBe(200);
   });
   const sealed=await request(prefix+'/user_label/author/resolve','POST',missing,3);
   expect(sealed.body.status).toBe(200);expect(sealed.body.data).toMatchObject({state:'not_applied',operation_id:missing.operation_id,result:{created:0,updated:0,count:0,revision:missing.revision}});
  });
  it(prefix+' enqueues a server-signed durable sync without claiming completion and exposes its complete original action for recovery',async()=>{
   await f.db.insert(systemConfig).values({menuName:'wechat_work_corpid',value:'corp-http-owned'});
   const r=await request(prefix+'/user/synchro/work/label','GET',undefined,3);
   expect(r.body.status).toBe(200);expect(r.body.data).toMatchObject({actor_id:3,operation:'sync',target_id:0,state:'queued',step:0});
   expect(sent).toHaveLength(1);const message=sent[0];expect(message.action).toBe('dispatchUserLabelSync');
   if(message.action!=='dispatchUserLabelSync')throw Error('Expected label Queue command');
   expect(message.command).toMatchObject({operation_id:r.body.data.operation_id,actor_id:3,operation:'sync',target_id:0,payload:{},payload_hash:r.body.data.payload_hash});
   expect(message.seal).toMatch(/^[a-f0-9]{64}$/);expect(message.actor_stamp).toMatch(/^[a-f0-9]{64}$/);expect(message.actor_stamp).not.toBe(md5(pwd));
   expect((await request(prefix+'/user_label/catalog','GET',undefined,3)).body.data).toMatchObject({sync_pending:message.command,sync_busy:true});
   const stop=await request(prefix+'/user_label/author/resolve','POST',message.command,3);expect(stop.body.data.state).toBe('not_applied');
  });
 }

 it('missing receipts remain business404 unknown and do not fabricate a terminal event',async()=>{
  await unchanged(async()=>{const r=await request('/adminapi/user_label/author/receipt/'+crypto.randomUUID(),'GET',undefined,3);
   expect(r.status).toBe(200);expect(r.body.status).toBe(404);expect(r.body.data).toBeNull();});
 });
 it('Queue enqueue failure retains the durable original command instead of rolling back or issuing another UUID',async()=>{
  await f.db.insert(systemConfig).values({menuName:'wechat_work_corpid',value:'corp-http-owned'});
  const a=await intent('sync',0);send.mockRejectedValueOnce(Error('controlled Queue ACK loss'));
  const r=await request('/adminapi/user_label/author/commit','POST',a,3);expect(r.body.status).not.toBe(200);
  expect((await request('/api/admin/user_label/author/receipt/'+a.operation_id,'GET',undefined,3)).body.data).toMatchObject({operation_id:a.operation_id,state:'queued'});
  expect((await request('/api/admin/user_label/catalog','GET',undefined,3)).body.data.sync_pending).toEqual(a);
  expect((await request('/adminapi/user_label/author/resolve','POST',a,3)).body.data.state).toBe('not_applied');
 });
 it('sync advancement and the legacy GET sync require manage, never just view, and fail closed without configuration',async()=>{
  const a=await intent('sync',0);await unchanged(async()=>{
   for(const [path,method,body,id]of [['/adminapi/user/synchro/work/label','GET',undefined,2],['/api/admin/user_label/sync/advance','POST',a,2],['/adminapi/user_label/author/commit','POST',a,3]] as const)
    expect((await request(path,method,body,id)).body.status).not.toBe(200);
  });expect(send).not.toHaveBeenCalled();
 });
 for(const [path,method,raw]of [
  ['/adminapi/user_label/catalog?unknown=1','GET',undefined],
  ['/api/admin/user/user_label?page=1&page=2','GET',undefined],
  ['/adminapi/user/user_label?limit=101','GET',undefined],
  ['/api/admin/user/user_label_cate?name=x&name=y','GET',undefined],
  ['/adminapi/user_label/author/commit','POST','{'],
  ['/api/admin/user_label/author/commit','POST',JSON.stringify({padding:'x'.repeat(65537)})],
 ] as const)it('rejects invalid HTTP query/body without writes '+path+' '+(raw?'body':'query'),async()=>{
  await unchanged(async()=>expect((await request(path,method,undefined,3,{raw})).body.status).not.toBe(200));
 });
 it('does not permit hidden-field, scope or provider-identity writes through the legacy adapter',async()=>{
  await unchanged(async()=>{
   for(const body of [{id:20,tagId:'et-takeover'},{id:20,type:1},{id:20,relationId:7},{id:20,name:'A',label_name:'B'},
    {id:20,labelCate:10,label_cate:11},{id:22,name:'foreign'},{id:20,name:'x'.repeat(21)}])
    expect((await request('/adminapi/user_label/save','POST',body,3)).body.status).not.toBe(200);
  });
 });
 it('a real relation or any-scope category child prevents destructive legacy calls without partial deletion',async()=>{
  await f.db.insert(userLabelRelation).values({uid:7,labelId:20,type:1,relationId:7});
  await f.db.insert(legacyCategory).values({id:13,pid:11,ownerId:7,name:'foreign child'});
  await unchanged(async()=>{
   expect((await request('/api/admin/user_label/del/20','DELETE',{},3)).body.status).not.toBe(200);
   expect((await request('/adminapi/user/user_label_cate/11','DELETE',{},3)).body.status).not.toBe(200);
  });
 });
 it('registers only exact label view/manage and owner recovery endpoints, without weakening adjacent permissions',()=>{
  expect(requiredAdminPermission('GET','user_label/catalog')).toBe('label.view');
  expect(requiredAdminPermission('GET','user/user_label/add/0')).toBe('label.view');
  expect(requiredAdminPermission('PUT','user/user_label_cate/11')).toBe('label.manage');
  expect(requiredAdminPermission('GET','user/synchro/work/label')).toBe('label.manage');
  expect(requiredAdminPermission('POST','user_label/sync/advance')).toBe('label.manage');
  expect(isAdminUserLabelRecoveryRoute('GET','/api/admin/user_label/author/receipt/'+crypto.randomUUID())).toBe(true);
  expect(isAdminUserLabelRecoveryRoute('POST','/adminapi/user_label/author/resolve')).toBe(true);
  for(const[method,path]of [['GET','user_label/unknown'],['PUT','user_label/author/commit'],['POST','user_label/author/receipt/a'],['GET','user_label/author/resolve'],['POST','user_label/sync/advance/extra']])
   expect(requiredAdminPermission(method,path)).toBeNull();
 });
});
