import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { systemAdmin, systemMenus, systemRole } from '../src/models/schema';
import { createToken,md5 } from '../src/utils/jwt';
import { fabLinkCatalogFixture,fabLinkEnv } from './helpers/fabLinkCatalogFixture';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('../src/lib/di',async original=>({...await original<typeof import('../src/lib/di')>(),createContainer:()=>{if(!wiring.container)throw Error('Owned FAB link HTTP fixture unavailable');return wiring.container;}}));
const env={...fabLinkEnv,UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',NODE_ENV:'test'} as unknown as Env;
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('registered FAB chooser HTTP/JWT and actual app/Admin LOGINs',()=>{
  let f:Awaited<ReturnType<typeof fabLinkCatalogFixture>>,fetchGuard:ReturnType<typeof vi.spyOn>;
  const app=createApp(),tokens=new Map<number,string>();
  beforeEach(async()=>{
    f=await fabLinkCatalogFixture();
    await f.db.insert(systemMenus).values({id:1612,type:1,authType:1,access:1,isDel:0,menuPath:'/admin/setting/pages/fab',uniqueAuth:'setting-system-fab'});
    const rules=['fab_settings.view','1612','config.manage,dise.manage,product.manage','fab_settings.manage'];
    await f.db.insert(systemRole).values(rules.map((rules,index)=>({id:index+1,type:1,roleName:`Owned catalog ${index}`,rules,status:1})));
    await f.db.insert(systemAdmin).values(rules.map((_rules,index)=>({id:index+1,account:`catalog-${index}`,pwd:'owned-password',level:1,roles:String(index+1),adminType:1,status:1,isDel:0})));
    for(let id=1;id<=4;id++)tokens.set(id,(await createToken(id,'admin',md5('owned-password'),env.APP_KEY)).token);
    fetchGuard=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('FAB chooser must not fetch providers or image origins');});
  },30000);
  afterEach(async()=>{if(fetchGuard)expect(fetchGuard).not.toHaveBeenCalled();fetchGuard?.mockRestore();tokens.clear();wiring.container=undefined;await f?.close();},30000);
  async function profiles(run:()=>Promise<void>){await f.withRuntimeRole(appPeer=>f.withRuntimeRole(async adminPeer=>{
    await f.installSlice(appPeer,adminPeer);expect(appPeer.pid).not.toBe(adminPeer.pid);
    wiring.container=createContainerFromDb(appPeer.db);Object.assign(env,{HYPERDRIVE:{connectionString:appPeer.connectionString},HYPERDRIVE_ADMIN:{connectionString:adminPeer.connectionString}});
    try{await run();}finally{wiring.container=undefined;}
  }));}
  async function request(prefix:string,actor:number|null,resource='link-targets?kind=product',method='GET'){
    const response=await app.request(`${prefix}/setting/fab/${resource}`,{method,headers:actor===null?{}:{Authorization:`Bearer ${tokens.get(actor)}`}},env);
    return {response,body:await response.json<{status:number;msg:string;data:any}>()};
  }
  it.each(['/adminapi','/api/admin'])('reads all chooser kinds through real registered routes on %s without body/source leaks or writes',async prefix=>profiles(async()=>{
    const before=await f.snapshot();
    for(const actor of [1,2,4]){
      const categories=await request(prefix,actor,'link-categories');expect(categories.body.status,categories.body.msg).toBe(200);expect(categories.response.headers.get('Cache-Control')).toContain('no-store');
      expect(categories.body.data.list).toHaveLength(13);
      for(const category of categories.body.data.list){const result=await request(prefix,actor,`link-targets?kind=${category.kind}`);expect(result.body.status,result.body.msg).toBe(200);expect(result.body.data).toMatchObject({page:1,limit:15});}
    }
    expect(await f.snapshot()).toEqual(before);
  }));
  it('enforces dedicated view authority, strict duplicate/unknown queries, actual identity and denies broad selector access',async()=>profiles(async()=>{
    for(const prefix of ['/adminapi','/api/admin']){
      for(const resource of ['link-categories','link-targets?kind=product']){
        expect((await request(prefix,null,resource)).body.status).toBe(410000);
        expect((await request(prefix,3,resource)).body.status).toBe(400011);
      }
      for(const resource of ['link-categories?parent_id=0','link-targets?kind=product&kind=news','link-targets?kind=product&raw=1','link-targets?kind=news&parent_id=11','link-targets?kind=product&page=102&limit=100'])expect((await request(prefix,1,resource)).body.status).toBe(400);
      expect((await request(prefix,1,'link-targets?kind=product&parent_id=11')).body.data.list.map((row:{id:number})=>row.id)).toEqual([21]);
      expect((await request(prefix,1,'link-targets?kind=integral')).body.data.list[0]).toMatchObject({id:61,selectable:true,url:'/pages/activity/goods_details/index?id=61&type=4'});
    }
  }));
});
