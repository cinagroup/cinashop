import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import {eq,sql} from 'drizzle-orm';
import type {AppVariables,Env} from '@/env';
import {createContainerFromDb} from '@/lib/di';
import {systemAdmin,systemRole,systemMenus} from '@/models/schema';
import {AdminGroupAuthorService} from '@/services/admin/AdminGroupAuthorService';
import {groupActionHash} from '@/services/admin/AdminGroupAuthorInput';
import {isAdminGroupRecoveryRoute,requiredAdminPermission,AdminPermissionService} from '@/services/admin/AdminPermissionService';
import {adminapiRoutes} from '@/routes/adminapi';
import {v1Routes} from '@/routes/v1';
import {errorHandler} from '@/middleware/error';
import {createToken,md5,type TokenType} from '@/utils/jwt';
import {groupActor,seedUserGroups} from './helpers/adminUserGroups';
import {createAdminGroupAuthorFixture} from './helpers/adminGroupAuthorFixture';
import type {GroupAction} from '../../view/common/groupAuthor';
const wiring=vi.hoisted(()=>({open:vi.fn(),close:vi.fn(async()=>{})}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createAdminDatabaseSession:wiring.open}));
const env={APP_KEY:'owned-group-http-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:''} as Env;

describe('mall user group author actual dual-prefix Hono/JWT and restricted SQL',()=>{
  let f:Awaited<ReturnType<typeof createAdminGroupAuthorFixture>>,service:AdminGroupAuthorService;
  const app=new Hono<{Bindings:Env;Variables:AppVariables}>();app.onError(errorHandler);
  app.use('*',async(c,next)=>{c.set('container',f.container);await next();});app.route('/adminapi',adminapiRoutes);app.route('/api',v1Routes);
  beforeAll(async()=>{
    f=await createAdminGroupAuthorFixture();service=new AdminGroupAuthorService(f.container);
    wiring.open.mockImplementation(()=>({container:createContainerFromDb(f.db),close:wiring.close}));
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Group HTTP forbids external I/O'));
  },30000);
  beforeEach(async()=>{
    await f.reset();await seedUserGroups(f.db);
    await f.db.insert(systemAdmin).values([{id:109,account:'foreign-realm',pwd:'group-fixture-password',level:0,adminType:4},
      {id:110,account:'foreign-related',pwd:'group-fixture-password',level:0,relationId:1}]);
    await f.exec("SELECT setval('public.user_group_id_seq',100,false)");
  });
  afterAll(async()=>{expect(fetch).not.toHaveBeenCalled();vi.restoreAllMocks();await f?.close();},30000);
  async function request(path:string,method='GET',body?:unknown,id=100,options:{type?:TokenType;auth?:string;raw?:string}={}){
    const token=id?(await createToken(id,options.type??'admin',options.auth??md5('group-fixture-password'),env.APP_KEY)).token:'';
    return f.asAdmin(async()=>{
      const response=await app.request(path,{method,headers:{...(token?{'Authori-zation':`Bearer ${token}`} : {}),'Content-Type':'application/json'},
        body:options.raw??(body===undefined?undefined:JSON.stringify(body))},env);
      return {status:response.status,headers:response.headers,body:await response.json() as {status:number;msg:string;data:any}};
    });
  }
  async function intent(actor_id=101):Promise<GroupAction>{
    const snapshot=await f.asAdmin(()=>service.catalog(new URLSearchParams(),groupActor(100)));
    const action:GroupAction={operation_id:crypto.randomUUID(),actor_id,operation:'update',target_id:20,revision:snapshot.revision,payload:{group_name:'HTTP编辑'},payload_hash:''};
    action.payload_hash=groupActionHash(action);return action;
  }
  async function snapshot(){const result:Record<string,unknown>={};
    for(const table of ['user_group','user','system_admin','system_role','system_log','admin_group_operation'])result[table]=Array.from(await f.db.execute(sql.raw(`SELECT * FROM public.${table==='user'?'"user"':table} ORDER BY 1`)));
    return result;
  }
  async function unchanged(run:()=>Promise<unknown>){const before=await snapshot();try{return await run();}finally{expect(await snapshot()).toEqual(before);}}

  for(const prefix of ['/adminapi','/api/admin']){
    const base=prefix+'/user/group/author';
    it(prefix+' returns the full safe directory with private cache headers through the actual Admin session factory',()=>unchanged(async()=>{
      const response=await request(base+'/catalog','GET',undefined,102);
      expect(response.body.status,response.body.msg).toBe(200);expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(response.body.data).toMatchObject({count:3,write_ready:true,list:[{id:30,group_name:'历史分组'},{id:20,group_name:'会员'},{id:10,group_name:'普通用户'}]});
      expect(JSON.stringify(response.body)).not.toMatch(/rowVersion|pwd|account|group-user|nowMoney/);expect(wiring.open).toHaveBeenCalled();expect(wiring.close).toHaveBeenCalled();
    }));
    it(prefix+' persists and replays one original UUID with exactly one group audit',async()=>{
      const action=await intent(),first=await request(base+'/commit','POST',action,101);
      expect(first.body.status,first.body.msg).toBe(200);expect(first.body.data.state).toBe('committed');
      await unchanged(async()=>{expect((await request(base+'/commit','POST',action,101)).body.data).toEqual(first.body.data);
        expect((await request(base+'/receipt/'+action.operation_id,'GET',undefined,101)).body.data).toEqual(first.body.data);});
    });
    it(prefix+' allows exact owner receipt and resolve after view/manage withdrawal but denies another owner',async()=>{
      const action=await intent();await f.db.update(systemRole).set({rules:''}).where(eq(systemRole.id,1));
      await unchanged(async()=>{
        expect((await request(base+'/commit','POST',action,101)).body.status).not.toBe(200);
        expect((await request(base+'/catalog','GET',undefined,101)).body.status).not.toBe(200);
        expect((await request(base+'/receipt/'+action.operation_id,'GET',undefined,101)).body.status).toBe(404);
      });
      const sealed=await request(base+'/resolve','POST',action,101);expect(sealed.body.status,sealed.body.msg).toBe(200);expect(sealed.body.data.state).toBe('not_applied');
      await unchanged(async()=>{
        expect((await request(base+'/receipt/'+action.operation_id,'GET',undefined,101)).body.data).toEqual(sealed.body.data);
        expect((await request(base+'/receipt/'+action.operation_id,'GET',undefined,100)).body.status).toBe(404);
        expect((await request(base+'/resolve','POST',action,100)).body.status).not.toBe(200);
      });
      await f.db.update(systemRole).set({rules:'user.manage'}).where(eq(systemRole.id,1));
      await unchanged(async()=>expect((await request(base+'/commit','POST',action,101)).body.status).not.toBe(200));
    });
    it(prefix+' keeps original numeric227/263 page grants read-only and real numeric265 writer separate',async()=>{
      for(const id of [106,107])await unchanged(async()=>{
        expect((await request(base+'/catalog','GET',undefined,id)).body.status).toBe(200);
        expect((await request(base+'/commit','POST',await intent(id),id)).body.status).toBe(400011);
      });
      const response=await request(base+'/commit','POST',await intent(104),104);expect(response.body.status,response.body.msg).toBe(200);
    });
    it(prefix+' does not treat view, form or unrelated product grants as mutation authority',async()=>{
      for(const id of [102,103,105,108])await unchanged(async()=>expect((await request(base+'/commit','POST',await intent(id),id)).body.status).not.toBe(200));
    });
    it(prefix+' rejects unexpected query keys, malformed/oversize JSON and extra author fields with zero mutation',async()=>{
      for(const path of ['/catalog?page=1','/catalog?id=1&id=2'])await unchanged(async()=>expect((await request(base+path)).body.status).not.toBe(200));
      for(const raw of ['[1]','{bad',' '.repeat(16385)])await unchanged(async()=>expect((await request(base+'/commit','POST',undefined,101,{raw})).body.status).not.toBe(200));
      const action=await intent();await unchanged(async()=>expect((await request(base+'/commit','POST',{...action,unknown:1},101)).body.status).not.toBe(200));
    });
  }
  it('rejects anonymous/App tokens, foreign realms and changed credentials even on owner routes',async()=>{
    for(const [id,options]of [[0,{}],[101,{type:'api'}],[109,{}],[110,{}],[101,{auth:md5('changed')}]] as const){
      const action=await intent(id||101);
      await unchanged(async()=>{
        expect((await request('/adminapi/user/group/author/catalog','GET',undefined,id,options)).body.status).not.toBe(200);
        expect((await request('/adminapi/user/group/author/resolve','POST',action,id,options)).body.status).not.toBe(200);
      });
    }
  });
  it('retains all four original PHP group routes and the three existing modern aliases',async()=>{
    expect((await request('/adminapi/user/user_group/list','GET',undefined,105)).body.data.count).toBe(3);
    const form=await request('/adminapi/user/user_group/add/20','GET',undefined,108);expect(form.body.data.rules[1]).toMatchObject({field:'group_name',props:{maxlength:20}});
    await unchanged(async()=>expect((await request('/adminapi/user/user_group/save','POST',{id:20,group_name:'名'.repeat(21)},104)).body.status).not.toBe(200));
    expect((await request('/adminapi/user/user_group/save','POST',{id:20,group_name:'旧接口仍可写'},104)).body.status).toBe(200);
    for(const prefix of ['/adminapi','/api/admin']){
      expect((await request(prefix+'/user_group/list?group_name=旧接口','GET',undefined,102)).body.data.count).toBe(1);
      const created=await request(prefix+'/user_group/save','POST',{id:0,group_name:prefix+'😀'.repeat(40)},101);expect(created.body.status,created.body.msg).toBe(200);
      expect((await request(prefix+'/user_group/del/'+created.body.data.id,'DELETE',undefined,101)).body.status).toBe(200);
    }
    expect((await request('/adminapi/user/user_group/del/20','DELETE',undefined,101)).body.status).toBe(200);
  });
  it('refuses forged numeric group page tuples without widening either resolver',async()=>{
    for(const patch of [{authType:2,apiUrl:'user/group/author/commit',methods:'POST'},{menuPath:'/user'},{uniqueAuth:'user.manage'},{methods:'GET'}]){
      await f.db.update(systemMenus).set({authType:1,apiUrl:'',methods:'',menuPath:'/admin/user/group',uniqueAuth:'user-user-group',...patch}).where(eq(systemMenus.id,227));
      await unchanged(async()=>{
        expect((await request('/adminapi/user/group/author/catalog','GET',undefined,106)).body.status).toBe(400011);
        expect(await f.asAdmin(()=>new AdminPermissionService(f.container).resolveManyRulePermissionKeys(['227']))).toEqual([[]]);
      });
    }
  });
  it('has exact registered author verbs and owner classifications without a prefix-wide exemption',()=>{
    for(const prefix of ['/adminapi','/api/admin']){
      expect(requiredAdminPermission('GET',prefix+'/user/group/author/catalog')).toBe('user.view');
      expect(requiredAdminPermission('POST',prefix+'/user/group/author/commit')).toBe('user.manage');
      for(const [method,path]of [['GET','receipt/:operationId'],['HEAD','receipt/40000000-0000-4000-8000-000000000001'],['POST','resolve']]){
        expect(isAdminGroupRecoveryRoute(method!,prefix+'/user/group/author/'+path)).toBe(true);expect(requiredAdminPermission(method!,prefix+'/user/group/author/'+path)).toBeNull();
      }
      for(const [method,path]of [['POST','receipt/x'],['GET','resolve'],['POST','catalog'],['PUT','commit'],['POST','resolve/extra'],['GET','receipt/x/extra']]){
        expect(isAdminGroupRecoveryRoute(method!,prefix+'/user/group/author/'+path)).toBe(false);expect(requiredAdminPermission(method!,prefix+'/user/group/author/'+path)).toBeNull();
      }
    }
  });
});
