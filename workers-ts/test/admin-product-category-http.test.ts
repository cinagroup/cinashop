import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {createApp} from '@/app';
import type {Env} from '@/env';
import {createToken,md5} from '@/utils/jwt';
import {productCategoryFixture,categoryBody} from './helpers/adminProductCategories';
import {storeProductCategory,systemLog} from '@/models/schema';
const wiring=vi.hoisted(()=>({application:vi.fn(),open:vi.fn(),close:vi.fn(async()=>{})}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:wiring.application,createAdminDatabaseSession:wiring.open}));
const env={APP_KEY:'category-http-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:''} as Env;
describe('complete application PHP category workflow with real JWT, authority and SQL',()=>{
  let f:Awaited<ReturnType<typeof productCategoryFixture>>,tokens:Record<number,string>;const app=createApp();
  beforeAll(async()=>{vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('HTTP external I/O forbidden'));f=await productCategoryFixture();wiring.application.mockImplementation(()=>f.container);wiring.open.mockImplementation(()=>({container:f.container,close:wiring.close}));tokens={};for(const id of [101,102,103,104,105,106])tokens[id]=(await createToken(id,'admin',md5('category-fixture-password'),env.APP_KEY)).token;},30000);
  afterAll(async()=>{try{expect(fetch).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();await f?.close();}},30000);
  const counters=()=>({app:wiring.application.mock.calls.length,open:wiring.open.mock.calls.length,close:wiring.close.mock.calls.length});
  function boundary(response:Response,before:ReturnType<typeof counters>){expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('pragma')).toBe('no-cache');expect(wiring.application.mock.calls.length-before.app).toBe(1);const opened=wiring.open.mock.calls.length-before.open;expect(opened).toBeGreaterThanOrEqual(0);expect(opened).toBeLessThanOrEqual(1);expect(wiring.close.mock.calls.length-before.close).toBe(opened);}
  async function request(method:string,path:string,body?:unknown,id=101){const before=counters(),response=await app.request(`/adminapi/${path}`,{method,headers:id?{'Authori-zation':`Bearer ${tokens[id]}`,'Content-Type':'application/json'}:{},body:body===undefined?undefined:JSON.stringify(body)},env);boundary(response,before);return {response,body:await response.json<{status:number;msg:string;data:any}>()};}
  it('returns each source read contract and both optional cascader forms through the registered app',async()=>{
    for(const path of ['product/category?page=1&limit=1','product/category/tree/0','product/category/tree/1','product/category/cascader_list','product/category/cascader_list/9','product/category/create','product/category/2']){const result=await request('GET',path);expect(result.body.status,result.body.msg).toBe(200);}
    expect((await request('GET','product/category?pid=1')).body.data.list[0]).toMatchObject({pid:1,path:'1',level:1,children:[]});expect((await request('GET','category/list')).body.data.find((row:any)=>row.id===3)).toMatchObject({pid:2,path:'1,2',level:2});
  });
  it('accepts complete old forms with body/path ID and completes create, edit, status and hard delete',async()=>{
    const created=await request('POST','product/category',{id:0,...categoryBody({cate_name:'HTTP分类'})});expect(created.body.status,created.body.msg).toBe(200);const id=created.body.data.id;
    expect((await request('PUT',`product/category/${id}`,{id,...categoryBody({pid:[4],cate_name:'HTTP编辑'})})).body.status).toBe(200);expect((await request('PUT',`product/category/set_show/${id}/0`)).body.data).toMatchObject({id,is_show:0,updated:1});expect((await request('DELETE',`product/category/${id}`)).body).toMatchObject({status:200,data:null});
    expect((await f.db.select().from(systemLog).orderBy(systemLog.id)).map(row=>row.method)).toEqual(['POST','PUT','PUT','DELETE']);
  });
  it('enforces product-only/numeric selectors and private anonymous/read-only rejection without writes',async()=>{
    const before=await f.db.select().from(storeProductCategory).orderBy(storeProductCategory.id),logs=(await f.db.select().from(systemLog)).length;
    expect((await request('GET','product/category',undefined,102)).body.status).toBe(200);expect((await request('POST','product/category',categoryBody(),102)).body).toMatchObject({status:400011,data:null});
    for(const id of [103,106]){expect((await request('GET','product/category/tree/1',undefined,id)).body.status).toBe(200);expect((await request('GET','product/category/cascader_list',undefined,id)).body.status).toBe(200);expect((await request('GET','product/category/create',undefined,id)).body.status).toBe(400011);}
    wiring.open.mockClear();for(const method of ['GET','POST'])expect((await request(method,'product/category',method==='POST'?categoryBody():undefined,0)).body).toMatchObject({status:410000,data:null});expect(wiring.open).not.toHaveBeenCalled();expect(await f.db.select().from(storeProductCategory).orderBy(storeProductCategory.id)).toEqual(before);expect((await f.db.select().from(systemLog)).length).toBe(logs);
    expect((await request('POST','product/category',categoryBody({cate_name:'numeric创建'}),105)).body.status).toBe(200);
  });
  it('rejects conflicts, opaque mutation, foreign owners and bounded UTF8 streams without effects',async()=>{
    const before=await f.db.select().from(storeProductCategory).orderBy(storeProductCategory.id),logs=(await f.db.select().from(systemLog)).length;
    for(const [method,path,body] of [['PUT','product/category/12',{id:0,...categoryBody()}],['POST','product/category',{id:12,...categoryBody()}],['POST','product/category',{...categoryBody(),type:2}],['PUT','product/category/8',categoryBody()],['PUT','product/category/set_show/12/2',undefined],['PUT','product/category/set_category/12',{cate_name:'猜测'}],['POST','category/save',{...categoryBody(),relation_id:77}]] as const)expect((await request(method,path,body)).body.status).not.toBe(200);
    for(const path of ['product/category/12','category/del/12'])expect((await request('DELETE',path,{expected_revision:'0'.repeat(64)})).body).toMatchObject({status:409,data:null});
    let cancelled=false;const stream=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(16385));},cancel(){cancelled=true;}},{highWaterMark:0});const raw=new Request('http://localhost/adminapi/product/category',{method:'POST',headers:{'Authori-zation':`Bearer ${tokens[101]}`,'Content-Type':'application/json'},body:stream,duplex:'half'} as RequestInit),start=counters(),response=await app.request(raw,undefined,env);boundary(response,start);expect(await response.json()).toMatchObject({status:400});expect(cancelled).toBe(true);expect(await f.db.select().from(storeProductCategory).orderBy(storeProductCategory.id)).toEqual(before);expect((await f.db.select().from(systemLog)).length).toBe(logs);
  });
});
