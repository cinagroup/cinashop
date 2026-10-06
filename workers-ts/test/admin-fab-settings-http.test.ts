/** Real registered application, JWT and independent production app/Admin LOGIN
 * slices. Only request connection wiring is supplied by this owned fixture. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { systemAdmin, systemDise, systemLog, systemMenus, systemRole } from '../src/models/schema';
import { fabCanonical, fabHash } from '../src/services/admin/AdminFabSettingsInput';
import { createToken, md5 } from '../src/utils/jwt';
import { fabBindings, fabNewValues, fabSettingsFixture } from './helpers/fabSettingsFixture';

const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('../src/lib/di',async original=>({...await original<typeof import('../src/lib/di')>(),
  createContainer:()=>{if(!wiring.container) throw Error('Owned FAB HTTP fixture unavailable');return wiring.container;},
}));
type HttpBindings=Pick<Env,'APP_KEY'|'UPSTASH_REDIS_URL'|'UPSTASH_REDIS_TOKEN'> & {NODE_ENV:'test'};
// Other bindings are unused by these requests. The values below are checked
// against their real binding types; provider/media fetches are forbidden.
const bindings={...fabBindings,UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',NODE_ENV:'test'} satisfies HttpBindings;
const env=bindings as unknown as Env;
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('FAB registered HTTP with genuine Admin authentication',()=>{
  let f:Awaited<ReturnType<typeof fabSettingsFixture>>;
  const app=createApp(),tokens=new Map<number,string>();
  const actors={manager:1,reader:2,legacy:3,generic:4,wrongPath:5,wrongAuth:6,second:8};
  let fetchGuard:ReturnType<typeof vi.spyOn>;
  beforeEach(async()=>{
    f=await fabSettingsFixture();
    await f.db.insert(systemMenus).values([
      {id:1612,type:1,authType:1,access:1,uniqueAuth:'setting-system-fab',menuPath:'/admin/setting/pages/fab'},
      {id:91613,type:1,authType:1,access:1,uniqueAuth:'setting-system-fab',menuPath:'/admin/setting/pages/theme'},
      {id:91614,type:1,authType:1,access:1,uniqueAuth:'setting-system-theme',menuPath:'/admin/setting/pages/fab'},
    ]);
    const rules:Record<string,string>={manager:'fab_settings.manage',reader:'fab_settings.view',legacy:'1612',generic:'config.manage,dise.manage',wrongPath:'91613',wrongAuth:'91614',second:'fab_settings.manage'};
    await f.db.insert(systemRole).values(Object.entries(actors).map(([name,id])=>({id,type:1,roleName:name,rules:rules[name]})));
    await f.db.insert(systemAdmin).values(Object.entries(actors).map(([name,id])=>({id,account:`fab-${name}`,pwd:'owned-fab-password',level:1,roles:String(id),adminType:1,status:1,isDel:0})));
    for(const id of Object.values(actors)) tokens.set(id,(await createToken(id,'admin',md5('owned-fab-password'),bindings.APP_KEY)).token);
    fetchGuard=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('FAB editor must not call providers or fetch images');});
  },30_000);
  afterEach(async()=>{if(fetchGuard) expect(fetchGuard).not.toHaveBeenCalled();fetchGuard?.mockRestore();tokens.clear();wiring.container=undefined;await f?.close();},30_000);
  async function profiles(run:(admin:{role:string})=>Promise<void>) {
    await f.withRuntimeRole(appPeer=>f.withRuntimeRole(async adminPeer=>{
      await f.installSlice(appPeer,adminPeer);
      for(const peer of [appPeer,adminPeer]) expect((await peer.exec('SELECT current_user,session_user'))[0]).toEqual({current_user:peer.role,session_user:peer.role});
      expect(appPeer.pid).not.toBe(adminPeer.pid);wiring.container=createContainerFromDb(appPeer.db);
      Object.assign(env,{HYPERDRIVE:{connectionString:appPeer.connectionString} as Env['HYPERDRIVE'],HYPERDRIVE_ADMIN:{connectionString:adminPeer.connectionString} as Env['HYPERDRIVE_ADMIN']});
      try {await run(adminPeer);} finally {wiring.container=undefined;}
    }));
  }
  async function request(prefix:string,actor:number|null,suffix='',method='GET',body?:unknown,raw?:string,path='/setting/fab') {
    const response=await app.request(`${prefix}${path}${suffix}`,{method,headers:{...(actor===null?{}:{Authorization:`Bearer ${tokens.get(actor)}`}),
      ...(body===undefined && raw===undefined?{}:{'Content-Type':'application/json'})},...(raw!==undefined?{body:raw}:body===undefined?{}:{body:JSON.stringify(body)})},env);
    return {response,body:await response.json<{status:number;msg:string;data:any}>()};
  }
  const page=async(prefix='/adminapi')=>(await request(prefix,actors.manager)).body.data;
  const input=(revision:string,values:unknown=fabNewValues())=>({request_id:crypto.randomUUID(),revision,values});

  it.each(['/adminapi','/api/admin'])('serves snapshot, confirmed write and actor-bound stable receipt on %s',async prefix=>{
    await profiles(async()=>{
      const initial=await request(prefix,actors.reader),before=await f.snapshot();
      expect(initial.body).toMatchObject({status:200,data:{present:true,editable:true,row:{id:88,status:0,is_show:0},values:{is_show:1,index:3}}});
      expect(initial.response.headers.get('Cache-Control')).toContain('no-store');expect(await f.snapshot()).toEqual(before);
      const body=input(initial.body.data.revision),saved=await request(prefix,actors.manager,'','POST',body);
      expect(saved.response.status).toBe(200);expect(saved.body).toMatchObject({status:200,data:{operation:'update',id:88,request_id:body.request_id,payload_hash:await fabHash(fabCanonical(body).canonical)}});
      expect((await request(prefix,actors.manager,`/request/${body.request_id}`)).body.data).toEqual(saved.body.data);
      const committed=await f.snapshot();expect((await request(prefix,actors.manager,'','POST',body)).body.data).toEqual(saved.body.data);expect(await f.snapshot()).toEqual(committed);
      expect((await page(prefix)).values).toEqual(fabNewValues());expect(committed.logs).toHaveLength(1);
    });
  });
  it('admits only exact legacy read authority and denies broad-domain, wrong-menu and reader writes without effects',async()=>{
    await profiles(async()=>{
      const body=input((await page()).revision),before=await f.snapshot();
      for(const prefix of ['/adminapi','/api/admin']) {
        for(const actor of [actors.reader,actors.legacy]) {
          expect((await request(prefix,actor)).body.status).toBe(200);
          expect((await request(prefix,actor,'','POST',body)).body).toMatchObject({status:400011,data:null});
        }
        for(const actor of [actors.generic,actors.wrongPath,actors.wrongAuth]) {
          expect((await request(prefix,actor)).body.status).toBe(400011);expect((await request(prefix,actor,'','POST',body)).body.status).toBe(400011);
        }
        expect((await request(prefix,null)).body.status).toBe(410000);
      }
      expect(await f.snapshot()).toEqual(before);
    });
  });
  it('binds UUID receipt and replay to actor/full intent and preserves unknown outcomes for corrupt journals',async()=>{
    await profiles(async()=>{
      const body=input((await page()).revision),saved=await request('/adminapi',actors.manager,'','POST',body);expect(saved.body.status).toBe(200);
      let before=await f.snapshot();
      for(const prefix of ['/adminapi','/api/admin']) {
        expect((await request(prefix,actors.second,`/request/${body.request_id}`)).response.status).toBe(404);
        expect((await request(prefix,actors.manager,`/request/${crypto.randomUUID()}`)).response.status).toBe(404);
        for(const [actor,data] of [[actors.second,body],[actors.manager,{...body,values:{...fabNewValues(),shifting:50}}]] as const) {
          const result=await request(prefix,actor,'','POST',data);expect(result.response.status).toBe(200);expect(result.body).toMatchObject({status:400,data:null});
        }
      }
      expect(await f.snapshot()).toEqual(before);
      await f.db.update(systemLog).set({action:'corrupt receipt'}).where(eq(systemLog.path,`/setting/fab/request/${body.request_id}`));before=await f.snapshot();
      const corrupt=await request('/adminapi',actors.manager,'','POST',body);expect(corrupt.response.status).toBe(200);expect(corrupt.body).toMatchObject({status:400,data:null});
      expect((await request('/api/admin',actors.manager,`/request/${body.request_id}`)).body).toMatchObject({status:400,data:null});expect(await f.snapshot()).toEqual(before);
    });
  });
  it.each(['/adminapi','/api/admin'])('proves actual409 stale rollback and matched pre-DML400 rejection separately on %s',async prefix=>{
    await profiles(async()=>{
      const initial=await page(prefix),body=input(initial.revision);await f.db.update(systemDise).set({title:'peer metadata change'}).where(eq(systemDise.id,88));
      let before=await f.snapshot();const stale=await request(prefix,actors.manager,'','POST',body);
      expect(stale.response.status).toBe(409);expect(stale.body).toMatchObject({status:409,data:{code:'FAB_SETTINGS_STALE_VERSION',operation:'update',request_id:body.request_id,payload_hash:await fabHash(fabCanonical(body).canonical)}});
      expect(await f.snapshot()).toEqual(before);expect((await request(prefix,actors.manager,`/request/${body.request_id}`)).response.status).toBe(404);
      const current=await page(prefix);
      for(const values of [{...fabNewValues(),main_ago_image:'/api/assets/42'}, {...fabNewValues(),button:[{source_id:'a'.repeat(64),img:'/i.png',url:'/pages/index/index'}]},
        {...fabNewValues(),button:[{source_id:null,img:'/i.png',url:'/pages/unknown/index'}]}]) {
        const rejectedBody=input(current.revision,values);before=await f.snapshot();const rejected=await request(prefix,actors.manager,'','POST',rejectedBody);
        expect(rejected.response.status).toBe(400);expect(rejected.body).toMatchObject({status:400,data:{code:'FAB_SETTINGS_REJECTED',operation:'update',request_id:rejectedBody.request_id,payload_hash:await fabHash(fabCanonical(rejectedBody).canonical)}});
        expect(await f.snapshot()).toEqual(before);expect((await request(prefix,actors.manager,`/request/${rejectedBody.request_id}`)).response.status).toBe(404);
      }
      const fresh=input(current.revision);expect((await request(prefix,actors.manager,'','POST',fresh)).body.status).toBe(200);
    });
  });
  it('keeps malformed body, duplicate keys, unknown query and transport errors outside deterministic proof',async()=>{
    await profiles(async()=>{
      const body=input((await page()).revision),before=await f.snapshot();
      for(const changed of [{...body,actor:8},{...body,request_id:'not-uuid'},{...body,revision:'a'},{...body,values:{...fabNewValues(),shifting:'10'}},
        {...body,values:{...fabNewValues(),button:[{source_id:null,img:'/i.png',url:'\t/pages/index/index'}]}}]) {
        const bad=await request('/adminapi',actors.manager,'','POST',changed);expect(bad.response.status).toBe(200);expect(bad.body).toMatchObject({status:400,data:null});
      }
      for(const raw of ['{bad',JSON.stringify(body).replace('"index":1','"index":1,"index":2')]) {
        expect((await request('/api/admin',actors.manager,'','POST',undefined,raw)).body).toMatchObject({status:400,data:null});
      }
      for(const suffix of ['?page=1','?id=88&id=88',`/request/${crypto.randomUUID()}?x=1`,'/request/not-uuid']) {
        expect((await request('/adminapi',actors.manager,suffix)).body).toMatchObject({status:400,data:null});
      }
      expect(await f.snapshot()).toEqual(before);
    });
  });
  it('blocks generic save on reserved/mistyped/normalized FAB identities while ordinary DIY editing remains usable',async()=>{
    await profiles(async()=>{
      for(const patch of [{templateName:'suspended_window',type:3},{templateName:' SUSPENDED_WINDOW ',type:1},{templateName:'mistyped-visual',type:3}]) {
        await f.db.update(systemDise).set(patch).where(eq(systemDise.id,88));const before=await f.snapshot();
        for(const prefix of ['/adminapi','/api/admin']) {
          const blocked=await request(prefix,actors.generic,'','POST',{id:88,value:'[]',name:'forged ordinary page'},undefined,'/dise/save');
          expect(blocked.response.status).toBe(200);expect(blocked.body).toMatchObject({status:400,data:null});expect(blocked.body.msg).toContain('专用可视化配置');
        }
        expect(await f.snapshot()).toEqual(before);
      }
      const ordinary=await request('/adminapi',actors.generic,'','POST',{id:1,value:'[]',name:'ordinary changed'},undefined,'/dise/save');
      expect(ordinary.body.status,ordinary.body.msg).toBe(200);
      expect((await f.db.select().from(systemDise).where(eq(systemDise.id,1)))[0].name).toBe('ordinary changed');
      expect((await f.snapshot()).logs).toHaveLength(0);
    });
  });
  it('rolls back missing initialization on absent real audit INSERT authority without claiming rejection, and refuses absent Admin binding',async()=>{
    await profiles(async admin=>{
      await f.db.delete(systemDise).where(eq(systemDise.id,88));const missing=await page();expect(missing.present).toBe(false);const before=await f.snapshot();
      await f.exec(`REVOKE INSERT ON system_log FROM "${admin.role}"`);
      const failed=await request('/adminapi',actors.manager,'','POST',input(missing.revision));expect(failed.body.status).not.toBe(200);expect(failed.body.data?.code).not.toBe('FAB_SETTINGS_REJECTED');expect(failed.body.data?.code).not.toBe('FAB_SETTINGS_STALE_VERSION');expect(await f.snapshot()).toEqual(before);
      const previous=env.HYPERDRIVE_ADMIN;delete (env as Partial<Env>).HYPERDRIVE_ADMIN;
      try {expect((await request('/api/admin',actors.manager)).body.status).not.toBe(200);expect(await f.snapshot()).toEqual(before);}
      finally {env.HYPERDRIVE_ADMIN=previous;}
    });
  });
});
