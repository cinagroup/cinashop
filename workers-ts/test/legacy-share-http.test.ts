import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Env, AppVariables } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { authMiddleware } from '@/middleware/auth';
import { legacyCache, storeProduct, systemConfig, systemSupplier, user } from '@/models/schema';
import { ApiException } from '@/utils/errors';
import { createToken, md5 } from '@/utils/jwt';
import * as Controller from '@/controllers/api/v1/LegacyShareCodeController';
import { financePostgres } from './helpers/financePostgres';
import { PRIVATE_SCAN_TABLES, MEMBER_CODE, seedPrivateScan, type PrivateScanFixture } from './helpers/legacyPrivateScanFixture';

describe('legacy share handler assembly with genuine optional UserJWT claims',()=>{
  let f:PrivateScanFixture,env:Env,app:Hono<{Bindings:Env;Variables:AppVariables}>,quota:number,provider:ReturnType<typeof vi.spyOn>;
  const config=new Map<string,string>();
  beforeAll(async()=>{f=await financePostgres([...PRIVATE_SCAN_TABLES,legacyCache,systemConfig,storeProduct,systemSupplier],{namespace:'public'});},30000);
  beforeEach(async()=>{
    await seedPrivateScan(f);quota=0;config.clear();provider=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('HTTP fixture forbids external provider traffic'));
    await f.db.insert(storeProduct).values({id:70,storeName:'HTTP真实商品',isShow:1,isVerify:1,isDel:0});
    await f.db.insert(systemConfig).values([{menuName:'site_name',value:'"HTTP商店"'},{menuName:'share_qrcode',value:'0'}]);
    env={APP_KEY:'owned-share-http-key',PUBLIC_H5_ORIGIN:'https://shop.example.test',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',
      CONFIG_KV:{get:async(key:string)=>config.get(key)??null,put:async(key:string,value:string)=>{config.set(key,value);},delete:async(key:string)=>{config.delete(key);}},
      TOKEN_BUCKET:{getByName:()=>({consumeRateLimit:async()=>{quota++;return{allowed:true,resetAt:Date.now()+60000};}})}} as unknown as Env;
    app=new Hono<{Bindings:Env;Variables:AppVariables}>();
    app.onError((error,c)=>c.json({status:error instanceof ApiException?error.code:500,msg:error.message}));
    app.use('*',async(c,next)=>{c.set('container',createContainerFromDb(f.db));await next();});
    app.get('/api/get_qrcode/:type/:id',authMiddleware({force:false}),Controller.code);
    app.get('/api/share/scene/:token',authMiddleware({force:false}),Controller.scene);
    app.get('/api/share/code/image/:token/:channel',Controller.image);
  });
  afterEach(()=>{provider.mockRestore();});afterAll(async()=>{await f?.close();},30000);
  const jwt=async(uid:number)=>(await createToken(uid,'api',md5(''),env.APP_KEY)).token;
  const request=async(path:string,token?:string)=>{
    const response=await app.request(path,{headers:token?{Authorization:`Bearer ${token}`}:{}},env);
    return{response,body:await response.json<{status:number;data?:Record<string,unknown>}>()};
  };
  it('generates a real owner artifact from UserJWT and permits only the signed image capability or authorized scene',async()=>{
    const owner=await jwt(11),generated=await request('/api/get_qrcode/90/0',owner);
    expect(generated.body.status).toBe(200);expect(Object.keys(generated.body.data!).sort()).toEqual(['nickname','routineUrl','site_name','wechatUrl']);
    const url=String(generated.body.data!.wechatUrl),token=new URL(url,'https://api.example.test').pathname.split('/')[5];
    expect(url).not.toContain(MEMBER_CODE);
    const image=await app.request(url,{},env);expect(image.headers.get('Content-Type')).toBe('image/gif');expect(image.headers.get('Cache-Control')).toBe('private, no-store');
    expect(new TextDecoder().decode(new Uint8Array(await image.arrayBuffer()).subarray(0,6))).toBe('GIF87a');
    expect((await request(`/api/share/scene/${token}`,owner)).body.data).toMatchObject({type:90,id:11,spid:0,viewer_scope:'owner',code:MEMBER_CODE,path:'/pages/user/memberCode'});
    const foreign=await request(`/api/share/scene/${token}`,await jwt(12));expect(foreign.body.status).not.toBe(200);expect(foreign.body.data).toBeUndefined();
    expect((await request(`/api/share/scene/${token}`)).body.status).not.toBe(200);expect(provider).not.toHaveBeenCalled();
  });
  it('uses the authenticated UID for public referrals and anonymous UID zero after password invalidation',async()=>{
    const owner=await jwt(11),first=await request('/api/get_qrcode/0/70',owner),firstToken=new URL(String(first.body.data!.wechatUrl),'https://api.example.test').pathname.split('/')[5];
    expect((await request(`/api/share/scene/${firstToken}`)).body.data).toMatchObject({type:0,id:70,spid:11});
    await f.db.update(user).set({pwd:'changed-http-password'}).where(eq(user.uid,11));
    const anonymous=await request('/api/get_qrcode/0/70',owner),token=new URL(String(anonymous.body.data!.wechatUrl),'https://api.example.test').pathname.split('/')[5];
    expect((await request(`/api/share/scene/${token}`)).body.data).toMatchObject({spid:0});
    const before=quota;expect((await request('/api/get_qrcode/90/0',owner)).body.status).not.toBe(200);expect(quota).toBe(before);
    expect(provider).not.toHaveBeenCalled();
  });
  it('rejects client identity injection and unauthenticated private generation before quota and enforces real owner on both private targets',async()=>{
    for(const path of['/api/get_qrcode/0/70?uid=11','/api/get_qrcode/0/70?spid=11','/api/get_qrcode/90/0'])expect((await request(path)).body.status).not.toBe(200);
    expect(quota).toBe(0);const foreign=await jwt(12);
    expect((await request('/api/get_qrcode/90/11',foreign)).body.status).not.toBe(200);
    expect((await request('/api/get_qrcode/91/0?order_id=owned-pickup-1',foreign)).body.status).not.toBe(200);
    expect(provider).not.toHaveBeenCalled();
  });
});
