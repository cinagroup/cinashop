import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {createApp} from '@/app';
import type {Env} from '@/env';
import {createToken,md5} from '@/utils/jwt';
import {productBrandFixture} from './helpers/adminProductBrands';
import {storeBrand,systemLog} from '@/models/schema';
const wiring=vi.hoisted(()=>({application:vi.fn(),open:vi.fn(),close:vi.fn(async()=>{})}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:wiring.application,createAdminDatabaseSession:wiring.open}));
const env={APP_KEY:'brand-http-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:''} as Env;
describe('complete application PHP brand hierarchy with actual JWT, role and SQL boundaries',()=>{
  let f:Awaited<ReturnType<typeof productBrandFixture>>,tokens:Record<number,string>;
  const app=createApp();
  beforeAll(async()=>{vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('HTTP external I/O forbidden'));f=await productBrandFixture();wiring.application.mockImplementation(()=>f.container);wiring.open.mockImplementation(()=>({container:f.container,close:wiring.close}));tokens={};for(const id of [101,102,103,104,105,106])tokens[id]=(await createToken(id,'admin',md5('brand-fixture-password'),env.APP_KEY)).token;},30000);
  afterAll(async()=>{try{expect(fetch).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();await f?.close();}},30000);
  const counters=()=>({application:wiring.application.mock.calls.length,open:wiring.open.mock.calls.length,close:wiring.close.mock.calls.length});
  function responseBoundary(response:Response,before:ReturnType<typeof counters>){
    expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('pragma')).toBe('no-cache');
    expect(wiring.application.mock.calls.length-before.application).toBe(1);const opened=wiring.open.mock.calls.length-before.open;expect(opened).toBeGreaterThanOrEqual(0);expect(opened).toBeLessThanOrEqual(1);expect(wiring.close.mock.calls.length-before.close).toBe(opened);
  }
  async function request(method:string,path:string,body?:unknown,id=101){const before=counters(),response=await app.request(`/adminapi/${path}`,{method,headers:id?{'Authori-zation':`Bearer ${tokens[id]}`,'Content-Type':'application/json'}:{},body:body===undefined?undefined:JSON.stringify(body)},env);responseBoundary(response,before);return {response,body:await response.json<{status:number;msg:string;data:any}>()};}
  it('reads lazy rows and both optional cascader path forms with private responses',async()=>{
    for(const path of ['product/brand','product/brand?pid=1','product/brand/cascader_list','product/brand/cascader_list/1','product/brand/cascader_list/2']){const result=await request('GET',path);expect(result.body.status,result.body.msg).toBe(200);expect(result.response.headers.get('cache-control')).toBe('private, no-store');}
    expect((await request('GET','product/brand?pid=1')).body.data.list[0]).toMatchObject({fid:[1],fid_son:[1,2],children:[],brand_num:0});
  });
  it('accepts exact old create and row-shaped edit bodies through all write routes',async()=>{
    const created=await request('POST','product/brand',{fid:[0],brand_name:'HTTP品牌',sort:7,is_show:1});expect(created.body.status,created.body.msg).toBe(200);const id=created.body.data.id;
    const row=(await request('GET','product/brand')).body.data.list.find((row:any)=>row.id===id);
    expect((await request('PUT',`product/brand/${id}`,{...row,fid:[4],brand_name:'HTTP编辑',sort:8})).body.status).toBe(200);
    expect((await request('PUT',`product/brand/set_show/${id}/0`)).body.data).toEqual({id,is_show:0});expect((await request('DELETE',`product/brand/${id}`)).body).toMatchObject({status:200,data:null});
    expect((await f.db.select().from(systemLog).orderBy(systemLog.id)).map(row=>row.method)).toEqual(['POST','PUT','PUT','DELETE']);
  });
  it('separates brand management from product-only and numeric selection capabilities',async()=>{
    expect((await request('GET','product/brand',undefined,102)).body.status).toBe(200);const beforeReadonly=await f.db.select().from(storeBrand).orderBy(storeBrand.id),readonlyLogs=(await f.db.select().from(systemLog)).length;
    expect((await request('POST','product/brand',{fid:[0],brand_name:'拒绝写'},102)).body).toMatchObject({status:400011,data:null});expect(await f.db.select().from(storeBrand).orderBy(storeBrand.id)).toEqual(beforeReadonly);expect((await f.db.select().from(systemLog)).length).toBe(readonlyLogs);
    for(const id of [103,106]){expect((await request('GET','product/brand/cascader_list/2',undefined,id)).body.status).toBe(200);expect((await request('GET','product/brand',undefined,id)).body.status).not.toBe(200);}
    expect((await request('POST','product/brand',{fid:[0],brand_name:'numeric创建'},105)).body.status).toBe(200);
    const beforeAnonymous=await f.db.select().from(storeBrand).orderBy(storeBrand.id),anonymousLogs=(await f.db.select().from(systemLog)).length;wiring.open.mockClear();
    for(const method of ['GET','POST'])expect((await request(method,'product/brand',method==='POST'?{fid:[0],brand_name:'匿名写'}:undefined,0)).body).toMatchObject({status:410000,data:null});
    expect(wiring.open).not.toHaveBeenCalled();expect(await f.db.select().from(storeBrand).orderBy(storeBrand.id)).toEqual(beforeAnonymous);expect((await f.db.select().from(systemLog)).length).toBe(anonymousLogs);
  });
  it('rejects conflicting IDs, owner forgery, invalid types and oversized streams without effects',async()=>{
    const before=await f.db.select().from(storeBrand).orderBy(storeBrand.id),logs=(await f.db.select().from(systemLog)).length;
    for(const [method,path,body] of [['PUT','product/brand/12',{id:0,fid:[0],brand_name:'路径冲突'}],['POST','product/brand',{store_id:7,fid:[0],brand_name:'门店伪造'}],['POST','product/brand',{relation_id:7,fid:[0],brand_name:'归属伪造'}],['PUT','product/brand/8',{fid:[0],brand_name:'外域'}],['PUT','product/brand/set_show/12/2',undefined],['GET','product/brand/cascader_list/3',undefined],['POST','brand/save',{brand_name:'虚假Logo',pic:'x'}]] as const)expect((await request(method,path,body)).body.status).not.toBe(200);
    let cancelled=false;const stream=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(16385));},cancel(){cancelled=true;}},{highWaterMark:0});
    const raw=new Request('http://localhost/adminapi/product/brand',{method:'POST',headers:{'Authori-zation':`Bearer ${tokens[101]}`,'Content-Type':'application/json'},body:stream,duplex:'half'} as RequestInit);
    const boundary=counters(),bounded=await app.request(raw,undefined,env);responseBoundary(bounded,boundary);expect(await bounded.json()).toMatchObject({status:400});expect(cancelled).toBe(true);expect(await f.db.select().from(storeBrand).orderBy(storeBrand.id)).toEqual(before);expect((await f.db.select().from(systemLog)).length).toBe(logs);expect(wiring.close).toHaveBeenCalled();
  });
});
