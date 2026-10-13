import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, type Container } from '@/lib/di';
import { legacyCache, user, systemConfig, storeProduct, systemStore, systemSupplier,
  storeSeckill, storeSeckillTime, storeCombination, storeBargain, storeIntegral, storeNewcomer } from '@/models/schema';
import { LegacyShareCodeService, parseLegacyShareInput, type LegacyShareActor } from '@/services/other/LegacyShareCodeService';
import { legacyShareWebsiteQr, parseLegacyShareOfficialScene, legacyShareOfficialScene, legacyShareDataImage } from '@/services/other/LegacyShareCodeProtocol';
import { md5 } from '@/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

export const legacyShareTestTables = [legacyCache,user,systemConfig,storeProduct,systemStore,systemSupplier,
  storeSeckill,storeSeckillTime,storeCombination,storeBargain,storeIntegral,storeNewcomer];
const password = 'local-share-password';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6JqkAAAAASUVORK5CYII=','base64');
const input = (type: number, id = type === -1 ? 0 : 70, query = '') => parseLegacyShareInput(String(type),String(id),new URLSearchParams(query));
const actor = (uid = 11): LegacyShareActor => ({uid,authVersion:uid?md5(password):'',expiresAt:uid?Math.floor(Date.now()/1000)+3600:0});
function token(url: string) { return new URL(url,'https://api.example.test').pathname.split('/')[5]; }
function imageQuery(url: string) { return new URL(url,'https://api.example.test').searchParams; }

describe('complete legacy share-code target, image, cache and provider contracts', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, container: Container, env: Env, service: LegacyShareCodeService;
  const requests: Array<{url:string;body?:Record<string,unknown>}> = [];
  const fetcher: typeof fetch = async (target,init) => {
    const url = new URL(String(target)); requests.push({url:url.href,...(init?.body?{body:JSON.parse(String(init.body))}:{})});
    if (url.hostname === 'api.weixin.qq.com' && url.pathname === '/cgi-bin/token') return Response.json({access_token:'owned-share-token',expires_in:7200});
    if (url.hostname === 'api.weixin.qq.com' && url.pathname === '/cgi-bin/qrcode/create') return Response.json({ticket:'owned-share-ticket',url:'https://weixin.qq.com/q/owned',expire_seconds:2592000});
    if (url.hostname === 'api.weixin.qq.com' && url.pathname === '/wxa/getwxacodeunlimit') return new Response(png,{headers:{'Content-Type':'image/png'}});
    if (url.hostname === 'mp.weixin.qq.com' && url.pathname === '/cgi-bin/showqrcode') return new Response(png,{headers:{'Content-Type':'image/png'}});
    throw Error('Uncontrolled provider URL');
  };
  beforeAll(async () => {
    f = await financePostgres(legacyShareTestTables); container = createContainerFromDb(f.db);
    env = {APP_KEY:'owned-share-key',PUBLIC_H5_ORIGIN:'https://shop.example.test',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',
      CONFIG_KV:{get:async()=>null,put:async()=>{},delete:async()=>{}}} as unknown as Env;
    service = new LegacyShareCodeService(container,env,fetcher);
    await f.db.insert(user).values({uid:11,account:'share-reader',pwd:password,nickname:'分享用户',status:1});
    await f.db.insert(storeProduct).values([{id:70,storeName:'真实商品',isShow:1,isVerify:1,isDel:0},
      {id:71,storeName:'预售商品',isShow:1,isVerify:1,isDel:0,isPresaleProduct:1}]);
    await f.db.insert(storeSeckillTime).values({id:3,status:1,startTime:'00:00',endTime:'23:59'});
    await f.db.insert(storeSeckill).values({id:70,productId:70,storeName:'秒杀',timeId:'3'});
    await f.db.insert(storeCombination).values({id:70,productId:70,storeName:'拼团'});
    await f.db.insert(storeBargain).values({id:70,productId:70,storeName:'砍价'});
    await f.db.insert(storeIntegral).values({id:70,productId:70,storeName:'积分'});
    await f.db.insert(storeNewcomer).values({id:70,productId:70});
    await f.db.insert(systemConfig).values([{menuName:'site_name',value:'"本机商店"'},
      {menuName:'share_qrcode',value:'0'},{menuName:'spread_share_forever',value:'0'}]);
  },30000);
  afterAll(async()=>{vi.restoreAllMocks();await f?.close();},30000);

  it('rejects unsupported types, injected identity, duplicate and unrelated query fields before SQL',()=>{
    for (const [type,id,query] of [['5','70',''],['0','0',''],['0','70','uid=99'],['0','70','user_type=wechat'],
      ['1','70','time=3&time=4'],['1','70','time=2147483648'],['1','70','status=unknown'],['91','0','order_id=../secret'],['90','0','order_id=abc']]) {
      expect(()=>parseLegacyShareInput(type,id,new URLSearchParams(query))).toThrow();
    }
  });
  it('provides all seven public product/activity targets to anonymous clients without inventing a referrer',async()=>{
    const paths = {0:'goods/detail',1:'activity/seckillDetail',2:'activity/bargainDetail',3:'activity/detail',4:'activity/integralDetail',6:'activity/presaleDetail',7:'activity/newcomerDetail'};
    for (const [raw,path] of Object.entries(paths)) {
      const type=Number(raw),reply=await service.code(input(type,type===6?71:70),actor(0),false);
      expect(Object.keys(reply).sort()).toEqual(['nickname','routineUrl','site_name','wechatUrl']);
      expect(reply).toMatchObject({site_name:'本机商店',nickname:'',routineUrl:''});
      const resolved=await service.scene(token(reply.wechatUrl),actor(0));
      expect(resolved).toMatchObject({type,id:type===6?71:70,spid:0,h5_origin:env.PUBLIC_H5_ORIGIN,path:`/pages/${path}?${type===2?'bargain_id':'id'}=${type===6?71:70}`});
      const response=await service.image(token(reply.wechatUrl),'wechat',imageQuery(reply.wechatUrl));
      expect(response.headers.get('Content-Type')).toBe('image/gif'); expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()).slice(0,6))).toBe('GIF87a');
    }
    expect(requests).toEqual([]);
  });
  it('returns current authenticated referral/name and preserves complete selected seckill time/status in the opaque target',async()=>{
    const reply=await service.code(input(1,70,'time=3&status=2'),actor(),false), t=token(reply.wechatUrl);
    expect(reply.nickname).toBe('分享用户');expect(t).toMatch(/^[a-f0-9]{24}$/);
    expect(await service.scene(t,actor(0))).toEqual({type:1,id:70,spid:11,h5_origin:env.PUBLIC_H5_ORIGIN,time:'3',status:'2',path:'/pages/activity/seckillDetail?id=70&spid=11&time=3&status=2'});
    expect(reply.wechatUrl).not.toMatch(/[?&](?:uid|spid|code)=/);
    await expect(service.code(input(1,70,'time=99'),actor(),false)).rejects.toThrow('时段');
  });
  it('replays an existing artifact without provider or database business mutations',async()=>{
    const beforeProducts=await f.db.select().from(storeProduct),beforeUsers=await f.db.select().from(user);
    const first=await service.code(input(0),actor(),false), second=await service.code(input(0),actor(),false);
    expect(token(second.wechatUrl)).toBe(token(first.wechatUrl));expect(requests).toEqual([]);
    expect(await f.db.select().from(storeProduct)).toEqual(beforeProducts);expect(await f.db.select().from(user)).toEqual(beforeUsers);
  });
  it('rechecks hidden/deleted products and actors on cache reuse, scene and signed image reads',async()=>{
    const reply=await service.code(input(0),actor(),false), t=token(reply.wechatUrl);
    try {await f.db.update(storeProduct).set({isShow:0}).where(eq(storeProduct.id,70));
      await expect(service.code(input(0),actor(),false)).rejects.toThrow();await expect(service.scene(t,actor(0))).rejects.toThrow();
      await expect(service.image(t,'wechat',imageQuery(reply.wechatUrl))).rejects.toThrow();
    } finally {await f.db.update(storeProduct).set({isShow:1}).where(eq(storeProduct.id,70));}
    try {await f.db.update(user).set({status:0}).where(eq(user.uid,11));await expect(service.scene(t,actor(0))).rejects.toThrow();}
    finally {await f.db.update(user).set({status:1}).where(eq(user.uid,11));}
  });
  it('rejects stale credentials and private code generation without a true live owner',async()=>{
    await expect(service.code(input(0),{...actor(),authVersion:md5('wrong')},false)).rejects.toThrow();
    for(const type of[90,91])await expect(service.code(input(type,0,type===91?'order_id=owned':''),actor(0),false)).rejects.toThrow('登录');
  });
  it('uses a genuine published landing PNG and signed temporary official scene, then replays both provider images',async()=>{
    await f.db.insert(systemConfig).values([{menuName:'routine_appId',value:'"owned-mini"'},{menuName:'routine_appsecret',value:'"private-mini"'},
      {menuName:'wechat_appid',value:'"owned-official"'},{menuName:'wechat_appsecret',value:'"private-official"'}]);
    await f.db.update(systemConfig).set({value:'1'}).where(eq(systemConfig.menuName,'share_qrcode'));
    const reply=await service.code(input(0),actor(),true), t=token(reply.wechatUrl);
    expect(reply.routineUrl).not.toBe('');
    const create=requests.find(request=>request.url.includes('/cgi-bin/qrcode/create'))!;
    const scene=(create.body!.action_info as any).scene.scene_str as string;
    expect(create.body).toMatchObject({expire_seconds:2592000,action_name:'QR_STR_SCENE'});
    expect(parseLegacyShareOfficialScene(scene,env.APP_KEY)?.token).toBe(t);expect(new TextEncoder().encode(scene).length).toBeLessThanOrEqual(64);
    const mini=requests.find(request=>request.url.includes('/wxa/getwxacodeunlimit'))!;
    expect(mini.body).toMatchObject({scene:`q=${t}`,page:'pages/share/landing',check_path:true,env_version:'release'});
    const image=await service.image(t,'routine',imageQuery(reply.routineUrl));expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    expect(await service.news('qrscene_'+scene)).toMatchObject({type:'news',title:'真实商品',url:`https://shop.example.test/#/pages/share/landing?q=${t}`});
    const count=requests.length;expect(token((await service.code(input(0),actor(),true)).wechatUrl)).toBe(t);expect(requests).toHaveLength(count);
  });
  it('implements configured permanent distributor tickets with a stable target and no expiry field in the provider request',async()=>{
    await f.db.update(systemConfig).set({value:'1'}).where(eq(systemConfig.menuName,'spread_share_forever'));
    const reply=await service.code(input(-1),actor(),true), t=token(reply.wechatUrl), create=requests.filter(request=>request.url.includes('/cgi-bin/qrcode/create')).at(-1)!;
    expect(create.body).toMatchObject({action_name:'QR_LIMIT_STR_SCENE'});expect(create.body).not.toHaveProperty('expire_seconds');
    const scene=(create.body!.action_info as any).scene.scene_str as string;expect(parseLegacyShareOfficialScene(scene,env.APP_KEY)).toEqual({token:t,expires:0});
    const count=requests.length;expect(token((await service.code(input(-1),actor(),true)).wechatUrl)).toBe(t);expect(requests).toHaveLength(count);
    expect(await service.scene(t,actor(0))).toMatchObject({type:-1,spid:11,path:'/pages/index/index?spid=11'});
  });
  it('rejects signature, channel, expiry and opaque record tampering before disclosing an image',async()=>{
    const reply=await service.code(input(0),actor(),false), t=token(reply.wechatUrl), query=imageQuery(reply.wechatUrl);
    const changed=new URLSearchParams(query);changed.set('signature','0'.repeat(64));await expect(service.image(t,'wechat',changed)).rejects.toThrow();
    await expect(service.image(t,'routine',query)).rejects.toThrow();
    const expired=new URLSearchParams(query);expired.set('expires','1');await expect(service.image(t,'wechat',expired)).rejects.toThrow();
    const [row]=await f.db.select().from(legacyCache).where(eq(legacyCache.key,`lshare:${t}`));
    try{await f.db.update(legacyCache).set({result:row.result!.replace('真实商品','changed').replace('"uid":11','"uid":12')}).where(eq(legacyCache.key,row.key));
      await expect(service.scene(t,actor(0))).rejects.toThrow('签名');
    }finally{await f.db.update(legacyCache).set({result:row.result}).where(eq(legacyCache.key,row.key));}
  });
  it('keeps the exact opaque scene after a provider outcome is unknown and a bounded retry lease expires',async()=>{
    const failure=new LegacyShareCodeService(container,env,async()=>{throw Error('PRIVATE-provider-result-unknown');});
    await expect(failure.code(input(7),actor(),true)).rejects.toThrow('生成失败');
    const rows=await f.db.select().from(legacyCache), document=rows.map(row=>row.result?JSON.parse(row.result):null).find(value=>value?.state==='pending'&&value.descriptor.type===7);
    expect(document).toBeTruthy();const clock=vi.spyOn(Date,'now').mockReturnValue((document.leaseUntil+1)*1000);
    try{const reply=await service.code(input(7),actor(),true);expect(token(reply.wechatUrl)).toBe(document.token);
      const create=requests.filter(request=>request.url.includes('/cgi-bin/qrcode/create')).at(-1)!;expect((create.body!.action_info as any).scene.scene_str).toBe(document.scene);
    }finally{clock.mockRestore();}
  });
  it('generates real GIF bytes and rejects disguised image formats and altered official signatures',()=>{
    expect(legacyShareWebsiteQr('https://shop.example.test/#/pages/share/landing?q='+'a'.repeat(24)).mime).toBe('image/gif');
    expect(()=>legacyShareDataImage('data:image/png;base64,PGh0bWw+')).toThrow();
    const scene=legacyShareOfficialScene('a'.repeat(24),Math.floor(Date.now()/1000)+3600,env.APP_KEY);
    expect(parseLegacyShareOfficialScene(scene.slice(0,-1)+(scene.endsWith('0')?'1':'0'),env.APP_KEY)).toBeNull();
    expect(parseLegacyShareOfficialScene(scene,'wrong-key')).toBeNull();
  });
  it('rejects an authoritative AppID change committed while the mini provider is generating and never publishes the artifact',async()=>{
    const before=(await f.db.select().from(legacyCache)).filter(row=>row.key.startsWith('lshare:')).length;
    let rotated=false;
    const changing:typeof fetch=async(target,init)=>{
      if(new URL(String(target)).pathname==='/wxa/getwxacodeunlimit'){
        rotated=true;await f.db.update(systemConfig).set({value:'"rotated-mini"'}).where(eq(systemConfig.menuName,'routine_appId'));
      }
      return fetcher(target,init);
    };
    try{
      await expect(new LegacyShareCodeService(container,env,changing).code(input(1,70,'time=3&status=1'),actor(),false)).rejects.toThrow('配置已变化');
      expect(rotated).toBe(true);expect((await f.db.select().from(legacyCache)).filter(row=>row.key.startsWith('lshare:')).length).toBe(before);
    }finally{await f.db.update(systemConfig).set({value:'"owned-mini"'}).where(eq(systemConfig.menuName,'routine_appId'));}
  });
});
