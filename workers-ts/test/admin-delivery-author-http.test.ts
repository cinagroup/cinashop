import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import {eq,sql} from 'drizzle-orm';
import type {AppVariables,Env} from '@/env';
import {createContainerFromDb} from '@/lib/di';
import {systemAdmin,systemRole,systemMenus,deliveryService,user} from '@/models/schema';
import {AdminDeliveryAuthorService} from '@/services/admin/AdminDeliveryAuthorService';
import {deliveryActionHash} from '@/services/admin/AdminDeliveryAuthorInput';
import {AdminPermissionService,requiredAdminPermission,isAdminDeliveryRecoveryRoute} from '@/services/admin/AdminPermissionService';
import {adminapiRoutes} from '@/routes/adminapi';
import {v1Routes} from '@/routes/v1';
import {errorHandler} from '@/middleware/error';
import {createToken,md5,type TokenType} from '@/utils/jwt';
import {newDeliveryValues,type DeliveryAction} from '../../view/common/deliveryAuthor';
import {createAdminDeliveryFixture} from './helpers/adminDeliveryFixture';
const wiring=vi.hoisted(()=>({open:vi.fn(),close:vi.fn(async()=>{})}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createAdminDatabaseSession:wiring.open}));
const pwd='owned-delivery-http-password',env={APP_KEY:'owned-delivery-http-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:''} as Env;
const actor=(id=1)=>({id,authVersion:md5(pwd),expiresAt:Math.floor(Date.now()/1000)+3600});

describe('platform delivery actual dual-prefix Hono/JWT and restricted SQL author',()=>{
 let f:Awaited<ReturnType<typeof createAdminDeliveryFixture>>,service:AdminDeliveryAuthorService;
 const app=new Hono<{Bindings:Env;Variables:AppVariables}>();app.onError(errorHandler);app.use('*',async(c,next)=>{c.set('container',f.container);await next();});app.route('/adminapi',adminapiRoutes);app.route('/api',v1Routes);
 beforeAll(async()=>{f=await createAdminDeliveryFixture();service=new AdminDeliveryAuthorService(f.container,env);wiring.open.mockImplementation(()=>({container:createContainerFromDb(f.db),close:wiring.close}));vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('HTTP delivery author cannot call providers'));},30000);
 afterAll(async()=>{expect(fetch).not.toHaveBeenCalled();vi.restoreAllMocks();await f?.close();},30000);
 beforeEach(async()=>{await f.reset();await f.db.insert(systemRole).values([{id:1,rules:'order.view'},{id:2,rules:'order.manage'},{id:3,rules:'attachment.manage'},{id:4,rules:'user.view'},{id:5,rules:'store.manage'}]);await f.db.insert(systemAdmin).values([{id:1,account:'root',pwd,level:0},{id:2,account:'reader',pwd,level:1,roles:'1'},{id:3,account:'writer',pwd,level:1,roles:'2'},{id:4,account:'attachment',pwd,level:1,roles:'3'},{id:5,account:'supplier',pwd,level:0,adminType:4},{id:6,account:'foreign',pwd,level:0,relationId:7},{id:7,account:'userreader',pwd,level:1,roles:'4'},{id:8,account:'storewriter',pwd,level:1,roles:'5'}]);await f.db.insert(user).values([{uid:7,account:'private-account7',pwd:'private-credential7',nickname:'原用户',phone:'13800000007',avatar:'https://original.test/a.png'},{uid:8,account:'private-account8',pwd:'private-credential8',nickname:'新用户',phone:'13800000008',avatar:'https://second.test/a.png'}]);await f.db.insert(deliveryService).values([{id:11,uid:7,type:0,relationId:0,nickname:'原配送员',phone:'13800000007',status:1},{id:12,uid:8,type:1,relationId:10,nickname:'只读门店配送',phone:'13800000008',status:1}]);await f.exec("SELECT setval('public.delivery_service_id_seq',100,false)");});
 async function request(path:string,method='GET',body?:unknown,id=1,options:{type?:TokenType;auth?:string;raw?:string}={}){const token=id?(await createToken(id,options.type??'admin',options.auth??md5(pwd),env.APP_KEY)).token:'';return f.asAdmin(async()=>{const r=await app.request(path,{method,headers:{...(token?{'Authori-zation':`Bearer ${token}`} : {}),'Content-Type':'application/json'},body:options.raw??(body===undefined?undefined:JSON.stringify(body))},env);return{status:r.status,headers:r.headers,body:await r.json() as {status:number;data:any;msg:string}};});}
 async function intent(owner=3){const c=await f.asAdmin(()=>service.catalog(new URLSearchParams(),actor())),a:DeliveryAction={operation_id:crypto.randomUUID(),actor_id:owner,operation:'update',target_id:11,payload:{...newDeliveryValues(c.list[0]),nickname:'HTTP编辑'},revision:c.revision,payload_hash:''};a.payload_hash=deliveryActionHash(a);return a;}
 async function snapshot(){const rows:Record<string,unknown>={};for(const t of ['delivery_service','user','system_admin','system_role','admin_delivery_operation'])rows[t]=Array.from(await f.db.execute(sql.raw(`SELECT * FROM public.${t==='user'?'"user"':t} ORDER BY 1`)));return rows;}
 async function unchanged(work:()=>Promise<unknown>){const b=await snapshot();try{return await work();}finally{expect(await snapshot()).toEqual(b);}}
 for(const prefix of ['/adminapi','/api/admin']){
  it(prefix+' preserves the fixed numeric720 PHP page as a read-only delivery catalog grant',async()=>{
   await f.db.insert(systemMenus).values({id:720,pid:1352,type:1,menuName:'配送员管理',module:'admin',sort:10,isShow:1,access:1,isDel:0,
    menuPath:'/admin/setting/delivery_service/index',path:'12/1350/1352',authType:1,uniqueAuth:'setting-delivery-service',apiUrl:'',methods:''});
   await f.db.update(systemRole).set({rules:'720'}).where(eq(systemRole.id,1));
   const action=await intent(2);
   await unchanged(async()=>{
    const read=await request(prefix+'/order/delivery/author/catalog','GET',undefined,2);
    expect(read.body.status,read.body.msg).toBe(200);expect(read.body.data.list).toHaveLength(1);
    expect((await request(prefix+'/order/delivery/author/commit','POST',action,2)).body.status).toBe(400011);
    for(const method of ['GET','PUT'])expect((await request(prefix+'/order/delivery/set_status/11/0',method,undefined,2)).body.status).toBe(400011);
    expect(await f.asAdmin(()=>new AdminPermissionService(f.container).resolveManyRulePermissionKeys(['720']))).toEqual([['order.view']]);
   });
  });
  it(prefix+' has safe complete platform rows and private no-store headers through the real Admin session factory',()=>unchanged(async()=>{const r=await request(prefix+'/order/delivery/author/catalog','GET',undefined,2);expect(r.body.status,r.body.msg).toBe(200);expect(r.headers.get('Cache-Control')).toBe('private, no-store');expect(r.body.data.list).toHaveLength(1);expect(r.body.data.list[0]).toMatchObject({id:11,uid:7,nickname:'原配送员',user_nickname:'原用户'});expect(JSON.stringify(r.body)).not.toMatch(/private-|只读门店|relationId|rowVersion/);expect(wiring.open).toHaveBeenCalled();expect(wiring.close).toHaveBeenCalled();}));
  it(prefix+' commits/replays one UUID and owner recovery survives management revocation',async()=>{const a=await intent(),first=await request(prefix+'/order/delivery/author/commit','POST',a,3);expect(first.body.status,first.body.msg).toBe(200);expect(first.body.data.state).toBe('committed');expect((await request(prefix+'/order/delivery/author/commit','POST',a,3)).body.data).toEqual(first.body.data);await f.db.update(systemRole).set({rules:''}).where(eq(systemRole.id,2));expect((await request(prefix+'/order/delivery/author/receipt/'+a.operation_id,'GET',undefined,3)).body.data).toEqual(first.body.data);});
  it(prefix+' support requires order.manage, returns real fallback phone and grants no broad user/attachment authority',()=>unchanged(async()=>{for(const path of ['users','attachment-categories','attachment-options']){const r=await request(prefix+'/order/delivery/author/'+path,'GET',undefined,3);expect(r.body.status,r.body.msg).toBe(200);expect(JSON.stringify(r.body)).not.toMatch(/private-|account|pwd/);if(path==='users')expect(r.body.data.list[0]).toMatchObject({uid:8,phone:'13800000008'});for(const id of [2,4,7,8])expect((await request(prefix+'/order/delivery/author/'+path,'GET',undefined,id)).body.status).not.toBe(200);}}));
  it(prefix+' legacy create normalizes original image UID/avatar before fallback and plain edit keeps UID immutable',async()=>{const made=await request(prefix+'/order/delivery/save','POST',{image:{uid:8,image:'https://second.test/a.png'},uid:0,avatar:'',nickname:'',phone:'',status:true},3);expect(made.body.status,made.body.msg).toBe(200);expect(made.body.data).toEqual({id:100});const info=(await request(prefix+'/order/delivery/100/edit','GET',undefined,3)).body.data;expect(info).toMatchObject({id:100,uid:8,nickname:'新用户',phone:'13800000008'});expect(info.info).toBeUndefined();const edited=await request(prefix+'/order/delivery/update/100','PUT',{...info,image:'https://changed.test/a.png',status:'0'},3);expect(edited.body.status,edited.body.msg).toBe(200);expect((await f.db.select().from(deliveryService).where(eq(deliveryService.id,100)))[0]).toMatchObject({avatar:'https://changed.test/a.png',uid:8,type:0,relationId:0,status:0});await unchanged(async()=>expect((await request(prefix+'/order/delivery/update/100','PUT',{uid:7},3)).body.status).not.toBe(200));});
  it(prefix+' restores real PHP GET status safely, PUT status, add metadata, select list and existing soft deletion',async()=>{const list=await request(prefix+'/order/delivery/index?keyword=原','GET',undefined,2);expect(list.body.data.list[0]).toMatchObject({wx_name:'原配送员',nickname:'原用户'});expect((await request(prefix+'/order/delivery/add','GET',undefined,2)).body.data.rules).toHaveLength(4);expect((await request(prefix+'/order/delivery/create','GET',undefined,2)).body.status).not.toBe(200);expect((await request(prefix+'/order/delivery/create','GET',undefined,3)).body.data.list.map((r:{uid:number})=>r.uid)).toEqual([8]);expect((await request(prefix+'/order/delivery/set_status/11/0','GET',undefined,2)).body.status).not.toBe(200);expect((await request(prefix+'/order/delivery/set_status/11/0','GET',undefined,3)).body.data).toEqual({id:11,status:0});expect((await request(prefix+'/order/delivery/list','GET',undefined,2)).body.data.count).toBe(0);expect((await request(prefix+'/order/delivery/set_status/11/1','PUT',undefined,3)).body.status).toBe(200);expect((await request(prefix+'/order/delivery/del/11','DELETE',undefined,3)).body.status).toBe(200);expect((await f.db.select().from(deliveryService).where(eq(deliveryService.id,11)))[0]).toMatchObject({isDel:1,status:0,type:0,relationId:0});expect((await f.db.select().from(deliveryService).where(eq(deliveryService.id,12)))[0]).toMatchObject({isDel:0,status:1,type:1,relationId:10});});
 }
 it('anonymous/App JWT/foreign realm/changed credential cannot read or write',async()=>{for(const [id,options]of [[0,{}],[3,{type:'api'}],[5,{}],[6,{}],[3,{auth:md5('changed')}]] as const)await unchanged(async()=>expect((await request('/adminapi/order/delivery/author/catalog','GET',undefined,id,options)).body.status).not.toBe(200));});
 it('unknown missing receipt remains404 until original owner explicitly seals and late commit is denied',async()=>{const a=await intent();expect((await request('/adminapi/order/delivery/author/receipt/'+a.operation_id,'GET',undefined,3)).body.status).toBe(404);await f.db.update(systemRole).set({rules:''}).where(eq(systemRole.id,2));expect((await request('/adminapi/order/delivery/author/resolve','POST',a,3)).body.data.state).toBe('not_applied');await f.db.update(systemRole).set({rules:'order.manage'}).where(eq(systemRole.id,2));await unchanged(async()=>expect((await request('/adminapi/order/delivery/author/commit','POST',a,3)).body.status).not.toBe(200));});
 it('another owner cannot recover or seal, and strict body/query budget fails without identity writes',async()=>{const a=await intent();await request('/adminapi/order/delivery/author/resolve','POST',a,3);await unchanged(async()=>{expect((await request('/adminapi/order/delivery/author/receipt/'+a.operation_id,'GET',undefined,1)).body.status).toBe(404);expect((await request('/adminapi/order/delivery/author/resolve','POST',a,1)).body.status).not.toBe(200);});for(const raw of ['[1]','{bad',' '.repeat(65537)])await unchanged(async()=>expect((await request('/adminapi/order/delivery/author/commit','POST',undefined,3,{raw})).body.status).not.toBe(200));await unchanged(async()=>expect((await request('/adminapi/order/delivery/index?page=1&page=2')).body.status).not.toBe(200));});
 it('HEAD on inherited GET status cannot mutate even for an authenticated writer',()=>unchanged(async()=>{const token=(await createToken(3,'admin',md5(pwd),env.APP_KEY)).token;await f.asAdmin(async()=>app.request('/adminapi/order/delivery/set_status/11/0',{method:'HEAD',headers:{'Authori-zation':`Bearer ${token}`}},env));expect((await f.db.select().from(deliveryService).where(eq(deliveryService.id,11)))[0]!.status).toBe(1);}));
 it('a forged numeric720 page/auth/API tuple cannot acquire read or management authority',async()=>{
  const original={id:720,type:1,authType:1,menuPath:'/admin/setting/delivery_service/index',uniqueAuth:'setting-delivery-service',apiUrl:'',methods:''};
  await f.db.insert(systemMenus).values(original);await f.db.update(systemRole).set({rules:'720'}).where(eq(systemRole.id,1));
  const action=await intent(2),forgeries=[
   {authType:2,apiUrl:'order/delivery/author/commit',methods:'POST'},
   {menuPath:'/order'},
   {uniqueAuth:'order.manage'},
   {methods:'GET'},
  ];
  for(const forged of forgeries){
   await f.db.update(systemMenus).set({...original,...forged}).where(eq(systemMenus.id,720));
   await unchanged(async()=>{
    expect((await request('/adminapi/order/delivery/author/catalog','GET',undefined,2)).body.status).toBe(400011);
    expect((await request('/adminapi/order/delivery/author/commit','POST',action,2)).body.status).toBe(400011);
    expect((await request('/adminapi/order/delivery/set_status/11/0','GET',undefined,2)).body.status).toBe(400011);
    expect(await f.asAdmin(()=>new AdminPermissionService(f.container).resolveManyRulePermissionKeys(['720']))).toEqual([[]]);
   });
  }
 });
 it('exact author namespace and legacy status permissions do not leak write capability to view or store roles',()=>{for(const prefix of ['/adminapi','/api/admin']){for(const path of ['/index','/list','/add','/:id/edit','/11/edit','/author/catalog'])expect(requiredAdminPermission('GET',prefix+'/order/delivery'+path)).toBe('order.view');for(const path of ['/create','/author/users','/author/attachment-categories','/author/attachment-options'])expect(requiredAdminPermission('GET',prefix+'/order/delivery'+path)).toBe('order.manage');for(const method of ['GET','PUT'])for(const path of ['/set_status/:id/:status','/set_status/11/0'])expect(requiredAdminPermission(method,prefix+'/order/delivery'+path)).toBe('order.manage');expect(requiredAdminPermission('HEAD',prefix+'/order/delivery/set_status/11/0')).toBeNull();expect(isAdminDeliveryRecoveryRoute('POST',prefix+'/order/delivery/author/resolve')).toBe(true);for(const[method,path]of [['GET','/author/commit'],['POST','/author/users'],['DELETE','/author/catalog'],['GET','/author/unknown']])expect(requiredAdminPermission(method,prefix+'/order/delivery'+path)).toBeNull();}});
});
