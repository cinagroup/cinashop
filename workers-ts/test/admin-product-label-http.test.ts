import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import type {AppVariables,Env} from '@/env';
import {adminapiRoutes} from '@/routes/adminapi';
import {ApiException} from '@/utils/errors';
import {createToken,md5} from '@/utils/jwt';
import {productLabelFixture} from './helpers/adminProductLabels';
import {storeProductLabel,systemLog} from '@/models/schema';
const wiring=vi.hoisted(()=>({open:vi.fn(),close:vi.fn(async()=>{})}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createAdminDatabaseSession:wiring.open}));
const env={APP_KEY:'label-http-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:''} as Env;
describe('registered complete PHP product-label workflow with actual JWT, authorization and SQL',()=>{
  let f:Awaited<ReturnType<typeof productLabelFixture>>,tokens:Record<number,string>;
  const app=new Hono<{Bindings:Env;Variables:AppVariables}>();
  app.use('*',async(c,next)=>{c.set('container',f.container);await next();expect(c.get('container')).toBe(f.container);});
  app.onError((error,c)=>c.json({status:error instanceof ApiException?error.code:500,msg:error.message,data:null}));
  app.route('/adminapi',adminapiRoutes);
  beforeAll(async()=>{
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('HTTP fixture forbids external I/O'));f=await productLabelFixture();
    wiring.open.mockImplementation(()=>({container:f.container,close:wiring.close}));tokens={};
    for(const id of [101,102,103,104,105,106])tokens[id]=(await createToken(id,'admin',md5('label-fixture-password'),env.APP_KEY)).token;
  },30000);
  afterAll(async()=>{try{expect(fetch).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();await f?.close();}},30000);
  async function request(method:string,path:string,body?:unknown,id=101){
    const response=await app.request(`/adminapi/product/${path}`,{method,headers:id?{'Authori-zation':`Bearer ${tokens[id]}`,'Content-Type':'application/json'}:{},body:body===undefined?undefined:JSON.stringify(body)},env);
    const result=await response.json<{status:number;msg:string;data:any}>();return {response,body:result};
  }
  it('serves every known group read/form tuple and creates, edits and deletes a group',async()=>{
    for(const path of ['label_cate','label_cate/create','label_cate/2/edit']){
      const result=await request('GET',path);expect(result.body.status,result.body.msg).toBe(200);expect(result.response.headers.get('cache-control')).toBe('private, no-store');
    }
    const create=await request('POST','label_cate',{name:'HTTP新增组',sort:3});expect(create.body.status,create.body.msg).toBe(200);
    const id=create.body.data.id;expect((await request('PUT',`label_cate/${id}`,{name:'HTTP编辑组',sort:4})).body.status).toBe(200);
    expect((await request('DELETE',`label_cate/${id}`)).body).toMatchObject({status:200,data:null});
    expect((await request('GET',`label_cate/${id}/edit`)).body.status).toBe(404);
    expect((await f.db.select().from(systemLog).orderBy(systemLog.id)).map(row=>row.method)).toEqual(['POST','PUT','DELETE']);
  });
  it('serves all known label read/form tuples and persists the complete workflow through real registered routes',async()=>{
    for(const path of ['label','product_label','all_label','label/form']){const result=await request('GET',path);expect(result.body.status,result.body.msg).toBe(200);}
    const create=await request('POST','label/0',{id:0,label_cate:2,label_name:'HTTP标签',style_type:2,icon:'https://static.example.test/tag.png',color:'',bg_color:'',border_color:'',is_show:1,status:1,sort:3});
    expect(create.body.status,create.body.msg).toBe(200);const id=create.body.data.id;
    expect((await request('POST',`label/${id}`,{id,label_cate:3,label_name:'HTTP编辑',style_type:1,color:'#123',bg_color:'#fff',border_color:'#abc',icon:'',is_show:1,status:1,sort:4})).body.status).toBe(200);
    expect((await request('PUT',`label/set_status/${id}/0`)).body.data).toEqual({id,status:0});
    expect((await request('PUT',`label/set_show/${id}/0`)).body.data).toEqual({id,is_show:0});
    expect((await request('DELETE',`label/${id}`)).body).toMatchObject({status:200,data:null});
    const bulk=await request('PUT','label/dels',{ids:[1,11],all:0,where:2});expect(bulk.body.data).toEqual({ids:[11],protected_ids:[1],count:1});
    expect((await f.db.select().from(systemLog).orderBy(systemLog.id)).slice(-6).map(row=>row.method)).toEqual(['POST','POST','PUT','PUT','DELETE','PUT']);
  });
  it('enforces management read/write separation and narrow product-selection capability on the actual registry',async()=>{
    expect((await request('GET','label',undefined,102)).body.status).toBe(200);
    expect((await request('POST','label/0',{label_cate:2,label_name:'不授权'},102)).body.status).not.toBe(200);
    for(const id of [103,106]){
      expect((await request('GET','product_label',undefined,id)).body.status).toBe(200);
      expect((await request('GET','all_label',undefined,id)).body.status).toBe(200);
      expect((await request('GET','label/form',undefined,id)).body.status).not.toBe(200);
      expect((await request('GET','label',undefined,id)).body.status).not.toBe(200);
    }
    expect((await request('POST','label/0',{label_cate:2,label_name:'数值授权标签'},105)).body.status).toBe(200);
    wiring.open.mockClear();expect((await request('GET','label',undefined,0)).body.status).not.toBe(200);expect(wiring.open).not.toHaveBeenCalled();
  });
  it('rejects unsafe payloads, malformed IDs and forged ownership without converting them into creates',async()=>{
    const before=await f.db.select().from(storeProductLabel).orderBy(storeProductLabel.id);
    const oldForm={id:0,label_cate:2,label_name:'旧表单',style_type:1,color:'#e93323',bg_color:'#fff',border_color:'#e93323',sort:0,is_show:1,icon:'',status:1};
    for(const [path,id] of [['label/10',0],['label/10',11],['label/0',10]] as const){
      expect((await request('POST',path,{...oldForm,id})).body).toMatchObject({status:400,msg:'标签正文ID必须与路径一致'});
    }
    for(const id of [null,-1,'1x','',2147483648])expect((await request('POST','label/0',{...oldForm,id})).body.status).toBe(400);
    expect((await request('POST','label/0',{...oldForm,type:2})).body.status).toBe(400);
    for(const [method,path,body] of [['POST','label/-1',{label_cate:2,label_name:'x'}],['POST','label/0',{type:2,label_cate:2,label_name:'x'}],
      ['PUT','label/set_status/10/2',undefined],['DELETE','label/20',undefined],['PUT','label/dels',{all:1,where:{type:2}}]] as const){
      expect((await request(method,path,body)).body.status).not.toBe(200);
    }
    const logCount=(await f.db.select().from(systemLog)).length;
    let cancelled=false,pulls=0;
    const stream=new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new Uint8Array(16385));},cancel(){cancelled=true;}},{highWaterMark:0});
    const oversized=new Request('http://localhost/adminapi/product/label/0',{method:'POST',headers:{'Authori-zation':`Bearer ${tokens[101]}`,'Content-Type':'application/json'},body:stream,duplex:'half'} as RequestInit);
    const bounded=await (await app.request(oversized,undefined,env)).json<{status:number;msg:string}>();
    expect(bounded.status).toBe(400);expect(bounded.msg).toContain('16 KiB');expect(cancelled).toBe(true);expect(pulls).toBe(1);
    const invalidUtf8=new Request('http://localhost/adminapi/product/label/0',{method:'POST',headers:{'Authori-zation':`Bearer ${tokens[101]}`,'Content-Type':'application/json'},body:new Uint8Array([0xff])});
    expect(await (await app.request(invalidUtf8,undefined,env)).json()).toMatchObject({status:400,msg:'请求数据不是有效 UTF-8'});
    expect((await f.db.select().from(systemLog)).length).toBe(logCount);
    expect(await f.db.select().from(storeProductLabel).orderBy(storeProductLabel.id)).toEqual(before);
    expect(wiring.close).toHaveBeenCalled();
  });
});
