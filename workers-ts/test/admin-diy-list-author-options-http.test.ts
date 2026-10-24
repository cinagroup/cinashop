import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { systemAdmin, systemMenus, systemRole } from '@/models/schema';
import { AdminPermissionService, assertDelegablePermissions, DISE_AUTHOR_SELECTION_PERMISSION } from '@/services/admin/AdminPermissionService';
import { createToken, md5 } from '@/utils/jwt';
import { diyListAuthorOptionsFixture } from './helpers/diyListAuthorOptionsFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned list author app LOGIN'); return wiring.container;
} }));
const resources = ['list-products', 'list-brands', 'list-labels', 'list-article-categories'];
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('registered list-author HTTP with actual JWT and distinct app/Admin SQL profiles', () => {
  const app = createApp(), tokens = new Map<number,string>(); let f: Awaited<ReturnType<typeof diyListAuthorOptionsFixture>>, env: Env;
  beforeEach(async () => {
    f = await diyListAuthorOptionsFixture(); env = f.env;
    await f.db.insert(systemMenus).values([
      {id:9721,type:1,authType:2,access:1,isDel:0,apiUrl:'/adminapi/dise/author-options/list-brands',methods:'GET'},
      {id:9722,type:1,authType:2,access:1,isDel:0,apiUrl:'/adminapi/dise/author-options/list-labels',methods:'POST'},
      {id:9723,type:1,authType:2,access:1,isDel:0,apiUrl:'/adminapi/dise/author-options/list-unknown',methods:'GET'},
    ]);
    const rules=['dise.manage','dise.view','product.manage,brand.manage,label.manage,fab_settings.manage,attachment.manage,config.manage','9721','9722','9723',DISE_AUTHOR_SELECTION_PERMISSION];
    await f.db.insert(systemRole).values(rules.map((rules,index)=>({id:index+1,roleName:'List author '+index,rules,status:1,type:1})));
    await f.db.insert(systemAdmin).values(rules.map((_rule,index)=>({id:index+1,account:'list-author-'+index,pwd:'owned-list-author-password',level:1,roles:String(index+1),adminType:1,status:1,isDel:0})));
    for(let id=1;id<=rules.length;id++)tokens.set(id,(await createToken(id,'admin',md5('owned-list-author-password'),env.APP_KEY)).token);
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Owned list author HTTP forbids external providers'));
  },30000);
  afterEach(async()=>{if(vi.isMockFunction(fetch))expect(fetch).not.toHaveBeenCalled();vi.restoreAllMocks();tokens.clear();wiring.container=undefined;await f?.close();},30000);
  async function profiles(work:()=>Promise<void>){
    await f.withRuntimeRole(appPeer=>f.withRuntimeRole(async adminPeer=>{
      await f.installSlice(appPeer,adminPeer);expect(appPeer.pid).not.toBe(adminPeer.pid);wiring.container=createContainerFromDb(appPeer.db);
      Object.assign(env,{HYPERDRIVE:{connectionString:appPeer.connectionString},HYPERDRIVE_ADMIN:{connectionString:adminPeer.connectionString}});
      try{await work();}finally{wiring.container=undefined;}
    }));
  }
  async function get(prefix:string,actor:number|null,resource:string,method='GET'){
    const before=await f.snapshot(),resourcesBefore=f.resources(),response=await app.request(prefix+'/dise/author-options/'+resource,{method,headers:actor===null?{}:{Authorization:'Bearer '+tokens.get(actor)}},env);
    const bytes=new Uint8Array(await response.arrayBuffer()),body=response.headers.get('Content-Type')?.includes('application/json')?JSON.parse(new TextDecoder().decode(bytes)):undefined;
    expect(await f.snapshot()).toEqual(before);expect(f.resources()).toEqual(resourcesBefore);return{response,body,bytes};
  }
  it.each(['/adminapi','/api/admin'])('reads all four actual typed catalogs on%s with each complete table/sequence/resource snapshot unchanged',async prefix=>profiles(async()=>{
    for(const resource of resources){const result=await get(prefix,1,resource);expect(result.body.status,result.body.msg).toBe(200);expect(result.response.headers.get('Cache-Control')).toBe('private, no-store');expect(result.body.data).toMatchObject({page:1,limit:15,issues:[]});}
    expect((await get(prefix,1,'list-brands?parent_id=3101')).body.data.list).toMatchObject([{id:3102,selection:{kind:'brand',id:3102}}]);
    expect((await get(prefix,1,'list-labels?search=%25_')).body.data.list.map((r:any)=>r.id)).toEqual([3206]);
    expect((await get(prefix,1,'list-article-categories?limit=1')).body.data.list).toEqual([{id:0,name:'热门',aggregate:true,selection:{kind:'article_category',id:0,name:'热门'}}]);
    const products=(await get(prefix,1,'list-products?search=供应商商品')).body.data.list;expect(products).toMatchObject([{id:23,selection:{kind:'product',id:23,name:'供应商商品'}}]);
    const before=await f.snapshot(),resourcesBefore=f.resources(),asset=await app.request(products[0].image_preview,{},env);expect(asset.status).toBe(200);expect(new Uint8Array(await asset.arrayBuffer())).toEqual(f.png);expect(await f.snapshot()).toEqual(before);expect(f.resources()).toEqual(resourcesBefore);
  }));
  it('rejects guests, pure readers, adjacent management and persisted virtual strings while admitting only the exact legacy GET permission',async()=>profiles(async()=>{
    for(const prefix of ['/adminapi','/api/admin'])for(const resource of resources){
      expect((await get(prefix,null,resource)).body.status).toBe(410000);
      for(const actor of [2,3,5,6,7])expect((await get(prefix,actor,resource)).body.status).toBe(400011);
      expect((await get(prefix,4,resource)).body.status).toBe(200);
      for(const method of ['POST','PUT','DELETE'])expect((await get(prefix,1,resource,method)).body?.status??404).not.toBe(200);
    }
  }));
  it('rechecks persisted role revocation and account disablement without opening a broader SQL or media path',async()=>profiles(async()=>{
    expect((await get('/adminapi',1,'list-brands')).body.status).toBe(200);
    await f.db.update(systemRole).set({rules:'dise.view'}).where(eq(systemRole.id,1));
    for(const resource of resources)expect((await get('/adminapi',1,resource)).body.status).toBe(400011);
    await f.db.update(systemAdmin).set({status:0}).where(eq(systemAdmin.id,4));
    for(const resource of resources)expect((await get('/api/admin',4,resource)).body.status).not.toBe(200);
  }));
  it('keeps canonical virtual permission nonselectable and nondelegable in actual numeric-menu batch and single resolvers',async()=>profiles(async()=>{
    const permission=new AdminPermissionService(wiring.container!);
    expect(await permission.resolveManyRulePermissionKeys(['9721','9722','9723',DISE_AUTHOR_SELECTION_PERMISSION])).toEqual([[DISE_AUTHOR_SELECTION_PERMISSION],[],[],[]]);
    for(const[index,rule]of['9721','9722','9723',DISE_AUTHOR_SELECTION_PERMISSION].entries())expect(await permission.resolveRulePermissionKeys(rule)).toEqual(index===0?[DISE_AUTHOR_SELECTION_PERMISSION]:[]);
    expect(()=>assertDelegablePermissions(new Set(['dise.manage']),[DISE_AUTHOR_SELECTION_PERMISSION])).toThrow();
  }));
  it('rejects duplicate/unknown/owner/kind queries on real registered endpoints and keeps literal SQL-looking search data read-only',async()=>profiles(async()=>{
    for(const resource of resources){
      for(const query of ['page=1&page=2','limit=101','owner_id=77','kind=news','search=%00'])expect((await get('/adminapi',1,resource+'?'+query)).body.status).toBe(400);
      const literal=await get('/api/admin',1,resource+'?search=%27%3BDELETE%20FROM%20store_brand%3B--');expect(literal.body.status).toBe(200);expect(literal.body.data.list).toEqual([]);
    }
    for(const resource of ['list-labels','list-article-categories'])expect((await get('/adminapi',1,resource+'?parent_id=0')).body.status).toBe(400);
  }));
});
