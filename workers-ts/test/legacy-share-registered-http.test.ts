import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, type Container } from '@/lib/di';
import { createApp } from '@/app';
import { legacyCache, storeProduct, systemAttachment, systemConfig, systemStoreStaff, systemSupplier, user } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { FOLLOW_BACKGROUND_BASE64 } from '@/services/wechat/WechatFollowBackground';
import { financePostgres } from './helpers/financePostgres';
import { PRIVATE_SCAN_TABLES, MEMBER_CODE, ORDER_CODE, seedPrivateScan, type PrivateScanFixture } from './helpers/legacyPrivateScanFixture';

const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{
  if(!wiring.container)throw Error('Owned registered share fixture unavailable');return wiring.container;
}}));
const png=Uint8Array.from(atob(FOLLOW_BACKGROUND_BASE64),value=>value.charCodeAt(0));
// Controlled Images binding output only; Cloudflare's actual JPEG encoder is a
// separately declared runtime acceptance boundary, not a claim of these tests.
const jpeg=new Uint8Array([255,216,255,224,0,16,255,217]);
type Stored={bytes:Uint8Array;httpMetadata:{contentType:string};customMetadata?:Record<string,string>};
type Envelope={status:number;msg?:string;data?:Record<string,unknown>|null};
const absolute=(path:string)=>new URL(path,'https://api.example.com').href;
const shareToken=(path:string)=>new URL(path,'https://api.example.com').pathname.split('/')[5];

describe('actual registered application legacy share and follow route contracts',()=>{
  let f:PrivateScanFixture,env:Env,app:ReturnType<typeof createApp>,provider:ReturnType<typeof vi.spyOn>;
  let quotas:number,transactions:number,selects:number,allowed:boolean,data:Map<string,Stored>;
  const config=new Map<string,string>();
  const storage={get:vi.fn(async(key:string)=>{const item=data.get(key);return item?{...item,size:item.bytes.length,body:new Response(item.bytes).body}:null;}),
    put:vi.fn(async(key:string,bytes:Uint8Array,options:Omit<Stored,'bytes'>)=>{data.set(key,{...options,bytes});})};
  const images={info:vi.fn(async()=>({format:'image/png',width:500,height:720})),input:vi.fn((_body:ReadableStream)=>{
    const image={transform:(_value:unknown)=>image,draw:(_input:unknown,_value:unknown)=>image,
      output:async(_value:unknown)=>({response:()=>new Response(jpeg,{headers:{'Content-Type':'image/jpeg'}})})};return image;
  })};
  beforeAll(async()=>{f=await financePostgres([...PRIVATE_SCAN_TABLES,legacyCache,systemConfig,systemAttachment,storeProduct,systemSupplier],{namespace:'public'});},30000);
  beforeEach(async()=>{
    await seedPrivateScan(f);config.clear();quotas=0;transactions=0;selects=0;allowed=true;
    storage.get.mockClear();storage.put.mockClear();images.info.mockClear();images.input.mockClear();
    data=new Map([['attachments/admin/1/follow.png',{bytes:png,httpMetadata:{contentType:'image/png'}}]]);
    await f.db.insert(storeProduct).values({id:70,storeName:'真实注册路由商品',isShow:1,isVerify:1,isDel:0});
    await f.db.insert(systemConfig).values([{menuName:'site_name',value:'"注册路由商店"'},{menuName:'share_qrcode',value:'0'},
      {menuName:'station_open',value:'1'},{menuName:'wechat_qrcode',value:'"/api/assets/41"'}]);
    await f.db.insert(systemAttachment).values({attId:41,type:1,relationId:0,moduleType:1,fileType:1,imageType:8,
      name:'attachments/admin/1/follow.png',attDir:'/api/assets/41',attType:'image/png',time:10});
    env={APP_KEY:'owned-registered-share-key',PUBLIC_H5_ORIGIN:'https://shop.example.com',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',
      CONFIG_KV:{get:async(key:string)=>config.get(key)??null,put:async(key:string,value:string)=>{config.set(key,value);},delete:async(key:string)=>{config.delete(key);}},
      TOKEN_BUCKET:{getByName:()=>({consumeRateLimit:async()=>{quotas++;return{allowed,resetAt:Date.now()+60000};}})},
      ASSETS_BUCKET:storage,IMAGES:images} as unknown as Env;
    // Observe an independent DbClient proxy. Do not spy on/mutate the PGlite
    // row-array adapter's transaction method or fabricate auth/SQL results.
    const observed=new Proxy(f.db,{get(target,key,receiver){const member:unknown=Reflect.get(target,key,receiver);if(typeof member!=='function')return member;
      return(...args:unknown[])=>{if(key==='transaction')transactions++;if(key==='select')selects++;return Reflect.apply(member,target,args);};}});
    wiring.container=createContainerFromDb(observed);app=createApp();
    provider=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Registered fixture forbids uncontrolled provider calls'));
  });
  afterEach(()=>{provider.mockRestore();wiring.container=undefined;});afterAll(async()=>{await f?.close();},30000);
  const jwt=async(uid:number,expired=false)=>(await createToken(uid,'api',md5(''),env.APP_KEY,'cinashop',expired?Math.floor(Date.now()/1000)-8*86400:undefined)).token;
  async function request(path:string,token?:string){const response=await app.request(absolute(path),{headers:token?{Authorization:`Bearer ${token}`}:{}},env);
    return{response,body:await response.json<Envelope>()};}
  async function generate(type:90|91,token:string,orderNo='owned-pickup-1'){
    const result=await request(`/api/get_qrcode/${type}/0${type===91?'?order_id='+orderNo:''}`,token);
    expect(result.body.status).toBe(200);return String(result.body.data!.wechatUrl);
  }
  function noStore(response:Response){expect(response.headers.get('Cache-Control')).toContain('no-store');}
  it('serves anonymous public QR, controlled scene and genuine GIF through actual createApp routes',async()=>{
    const generated=await request('/api/get_qrcode/0/70');expect(generated.body.status).toBe(200);noStore(generated.response);
    expect(Object.keys(generated.body.data!).sort()).toEqual(['nickname','routineUrl','site_name','wechatUrl']);
    const path=String(generated.body.data!.wechatUrl),scene=await request(`/api/share/scene/${shareToken(path)}`);
    expect(scene.body.status).toBe(200);expect(scene.body.data).toMatchObject({type:0,id:70,spid:0,path:'/pages/goods/detail?id=70',h5_origin:'https://shop.example.com'});noStore(scene.response);
    const image=await app.request(absolute(path),{},env);expect(image.status).toBe(200);noStore(image);
    expect(image.headers.get('Content-Type')).toBe('image/gif');
    expect(new TextDecoder().decode(new Uint8Array(await image.arrayBuffer()).subarray(0,6))).toBe('GIF87a');expect(provider).not.toHaveBeenCalled();
  });
  it.each([90,91] as const)('enforces real owner and SQL-backed reader realms for registered private type %s',async type=>{
    const owner=await jwt(11),path=await generate(type,owner),token=shareToken(path),code=type===90?MEMBER_CODE:ORDER_CODE;
    expect(path).not.toContain(code);
    for(const [uid,scope]of[[11,'owner'],[101,'staff'],[301,'customer']]as const){const result=await request(`/api/share/scene/${token}`,await jwt(uid));
      expect(result.body.status).toBe(200);expect(result.body.data).toMatchObject({type,spid:0,namespace:type===90?'member':'order',code,viewer_scope:scope,h5_origin:'https://shop.example.com'});
      expect(String(result.body.data!.path)).not.toContain(code);noStore(result.response);}
    for(const credential of[undefined,await jwt(12),await jwt(11,true)]){const result=await request(`/api/share/scene/${token}`,credential);expect(result.body.status).not.toBe(200);expect(result.body.data).toBeNull();noStore(result.response);}
    expect((await request(`/api/get_qrcode/${type}/0${type===91?'?order_id=owned-pickup-1':''}`,await jwt(11,true))).body.status).not.toBe(200);
    if(type===91)expect((await request('/api/get_qrcode/91/0?order_id=owned-pickup-1',await jwt(12))).body.status).not.toBe(200);
    else expect((await request('/api/get_qrcode/90/11',await jwt(12))).body.status).not.toBe(200);
    await f.db.update(user).set({pwd:'registered-password-rotated'}).where(eq(user.uid,11));
    const before=quotas;expect((await request(`/api/get_qrcode/${type}/0${type===91?'?order_id=owned-pickup-1':''}`,owner)).body.status).not.toBe(200);expect(quotas).toBe(before);
    expect((await request(`/api/share/scene/${token}`,owner)).body.status).not.toBe(200);expect(provider).not.toHaveBeenCalled();
  });
  it('uses the actual assigned delivery reader and rejects a revoked staff identity through registered scene',async()=>{
    const owner=await jwt(11),deliveryPath=await generate(91,owner,'owned-delivery');
    expect((await request(`/api/share/scene/${shareToken(deliveryPath)}`,await jwt(201))).body.data).toMatchObject({viewer_scope:'delivery',path:'/pages/delivery/scanning'});
    expect((await request(`/api/share/scene/${shareToken(deliveryPath)}`,await jwt(202))).body.status).not.toBe(200);
    const memberPath=await generate(90,owner);await f.db.update(systemStoreStaff).set({status:0}).where(eq(systemStoreStaff.uid,101));
    expect((await request(`/api/share/scene/${shareToken(memberPath)}`,await jwt(101))).body.status).not.toBe(200);
  });
  it('rejects bad share-image signatures before quota and all SQL on the signed derivative route',async()=>{
    const expires=Math.floor(Date.now()/1000)+900,quotasBefore=quotas,txBefore=transactions,selectBefore=selects;
    const bad=await request(`/api/share/code/image/${'a'.repeat(24)}/wechat?expires=${expires}&signature=${'0'.repeat(64)}`);
    expect(bad.body.status).not.toBe(200);noStore(bad.response);expect(quotas).toBe(quotasBefore);expect(transactions).toBe(txBefore);expect(selects).toBe(selectBefore);
    expect(storage.get).not.toHaveBeenCalled();expect(provider).not.toHaveBeenCalled();
  });
  it('runs both registered follow endpoints, preserves exact DTO and rejects invalid parameters and refused budgets before raster work',async()=>{
    const first=await request('/api/wechat/follow');expect(first.body.status).toBe(200);expect(Object.keys(first.body.data!)).toEqual(['path']);noStore(first.response);
    const path=String(first.body.data!.path),image=await app.request(path,{},env);expect(image.status).toBe(200);noStore(image);
    expect(image.headers.get('Content-Type')).toBe('image/jpeg');expect(new Uint8Array(await image.arrayBuffer())).toEqual(jpeg);
    const before=quotas;expect((await request('/api/wechat/follow?url=https%3A%2F%2Fevil.example.com')).body.status).not.toBe(200);expect(quotas).toBe(before);
    storage.get.mockClear();images.input.mockClear();allowed=false;const denied=await request('/api/wechat/follow');
    expect(denied.response.status).toBe(429);noStore(denied.response);expect(storage.get).not.toHaveBeenCalled();expect(images.input).not.toHaveBeenCalled();
  });
  it('validates follow image signatures before quota/SQL and revokes the old signature after source bytes change',async()=>{
    const generated=await request('/api/wechat/follow');expect(generated.body.status).toBe(200);const path=String(generated.body.data!.path),url=new URL(path);
    const beforeQuota=quotas,beforeTx=transactions,beforeSelect=selects;storage.get.mockClear();url.searchParams.set('signature','0'.repeat(64));
    const invalid=await request(url.href);expect(invalid.body.status).not.toBe(200);expect(quotas).toBe(beforeQuota);expect(transactions).toBe(beforeTx);expect(selects).toBe(beforeSelect);expect(storage.get).not.toHaveBeenCalled();
    const changed=png.slice();changed[30]^=1;data.set('attachments/admin/1/follow.png',{bytes:changed,httpMetadata:{contentType:'image/png'}});
    const revoked=await request(path);expect(revoked.body.status).not.toBe(200);noStore(revoked.response);
  });
  it('applies real StationOpen SQL to both legacy entrypoints and scene without consuming budget or accessing provider/storage',async()=>{
    const open=await request('/api/get_qrcode/0/70');expect(open.body.status).toBe(200);const token=shareToken(String(open.body.data!.wechatUrl));
    await f.db.update(systemConfig).set({value:'0'}).where(eq(systemConfig.menuName,'station_open'));const before=quotas;
    for(const path of['/api/get_qrcode/0/70',`/api/share/scene/${token}`,'/api/wechat/follow']){const closed=await request(path);expect(closed.body.status).toBe(410010);noStore(closed.response);}
    expect(quotas).toBe(before);expect(storage.get).not.toHaveBeenCalled();expect(provider).not.toHaveBeenCalled();
  });
  it('returns only the current authoritative H5 origin and rejects cached targets after its configured origin changes',async()=>{
    const result=await request('/api/get_qrcode/0/70');expect(result.body.status).toBe(200);const token=shareToken(String(result.body.data!.wechatUrl));
    const otherHost=await request(`https://wrong.example.com/api/share/scene/${token}`);
    expect(otherHost.body.status).toBe(200);expect(otherHost.body.data).toMatchObject({h5_origin:'https://shop.example.com'});
    expect((await request(`/api/share/scene/${token}?h5_origin=https%3A%2F%2Fwrong.example.com`)).body.status).not.toBe(200);
    env.PUBLIC_H5_ORIGIN='https://changed-shop.example.com';
    expect((await request(`/api/share/scene/${token}`)).body.status).not.toBe(200);
    expect((await request(String(result.body.data!.wechatUrl))).body.status).not.toBe(200);
  });
});
