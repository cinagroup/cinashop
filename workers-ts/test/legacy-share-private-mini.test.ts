import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { legacyCache, systemConfig } from '@/models/schema';
import { LegacyShareCodeService, parseLegacyShareInput } from '@/services/other/LegacyShareCodeService';
import { OfficialAccountQrcodeService } from '@/services/wechat/OfficialAccountQrcodeService';
import { WechatMiniProgramCodeService } from '@/services/wechat/WechatMiniProgramCodeService';
import { md5 } from '@/utils/jwt';
import { financePostgres } from './helpers/financePostgres';
import { PRIVATE_SCAN_TABLES, MEMBER_CODE, ORDER_CODE, seedPrivateScan, type PrivateScanFixture } from './helpers/legacyPrivateScanFixture';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6JqkAAAAASUVORK5CYII=','base64');
describe('private legacy share uses real published mini images and protected official callback landing',()=>{
  let f:PrivateScanFixture,env:Env;const config=new Map<string,string>(),requests:{url:string;body?:Record<string,unknown>}[]=[];
  const input=(type:90|91)=>parseLegacyShareInput(String(type),'0',new URLSearchParams(type===91?'order_id=owned-pickup-1':''));
  const actor=()=>({uid:11,authVersion:md5(''),expiresAt:Math.floor(Date.now()/1000)+3600});
  const token=(path:string)=>new URL(path,'https://api.example.test').pathname.split('/')[5];
  const fetcher:typeof fetch=async(target,init)=>{
    const url=new URL(String(target));requests.push({url:url.href,...(init?.body?{body:JSON.parse(String(init.body))}:{})});
    if(url.pathname==='/cgi-bin/token')return Response.json({access_token:'owned-private-image-token',expires_in:7200});
    if(url.pathname==='/cgi-bin/qrcode/create')return Response.json({ticket:'owned-private-image-ticket'});
    if(url.pathname==='/wxa/getwxacodeunlimit'||url.hostname==='mp.weixin.qq.com')return new Response(png,{headers:{'Content-Type':'image/png'}});
    throw Error('Uncontrolled private fixture provider');
  };
  beforeAll(async()=>{f=await financePostgres([...PRIVATE_SCAN_TABLES,legacyCache,systemConfig],{namespace:'public'});},30000);
  beforeEach(async()=>{
    await seedPrivateScan(f);config.clear();requests.length=0;
    env={APP_KEY:'owned-private-mini-key',PUBLIC_H5_ORIGIN:'https://shop.example.test',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',
      CONFIG_KV:{get:async(key:string)=>config.get(key)??null,put:async(key:string,value:string)=>{config.set(key,value);},delete:async(key:string)=>{config.delete(key);}}} as unknown as Env;
    await f.db.insert(systemConfig).values([{menuName:'site_name',value:'"本机商店"'},{menuName:'share_qrcode',value:'1'},{menuName:'spread_share_forever',value:'1'},
      {menuName:'routine_appId',value:'"owned-private-mini"'},{menuName:'routine_appsecret',value:'"private-mini-secret"'},
      {menuName:'wechat_appid',value:'"owned-private-official"'},{menuName:'wechat_appsecret',value:'"private-official-secret"'}]);
  });
  afterAll(async()=>{await f?.close();},30000);
  it.each([90,91] as const)('generates and downloads a genuine type %s mini PNG with opaque registered-page scene',async type=>{
    const service=new LegacyShareCodeService(createContainerFromDb(f.db),env,fetcher),result=await service.code(input(type),actor(),false),t=token(result.routineUrl);
    expect(result.routineUrl).not.toBe('');const request=requests.find(value=>value.url.includes('/wxa/getwxacodeunlimit'))!;
    expect(request.body).toMatchObject({scene:`q=${t}`,page:'pages/share/landing',check_path:true,env_version:'release'});
    expect(new TextEncoder().encode(String(request.body?.scene)).length).toBe(26);
    expect(JSON.stringify(requests)).not.toContain(type===90?MEMBER_CODE:ORDER_CODE);
    const image=await service.image(t,'routine',new URL(result.routineUrl,'https://api.example.test').searchParams);
    expect(image.headers.get('Content-Type')).toBe('image/png');expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    expect(await service.scene(t,actor())).toMatchObject({viewer_scope:'owner'});
  });
  it('uses temporary signed private official tickets and returns login guidance without code or referral disclosure',async()=>{
    const service=new LegacyShareCodeService(createContainerFromDb(f.db),env,fetcher),result=await service.code(input(90),actor(),true),t=token(result.wechatUrl);
    const request=requests.find(value=>value.url.includes('/cgi-bin/qrcode/create'))!,scene=(request.body!.action_info as {scene:{scene_str:string}}).scene.scene_str;
    expect(request.body).toMatchObject({action_name:'QR_STR_SCENE',expire_seconds:2592000});expect(scene).toContain(`ls:${t}:`);
    expect(JSON.stringify(requests)).not.toContain(MEMBER_CODE);
    const reply=await service.news(`qrscene_${scene}`,'owned-private-image-ticket');
    expect(reply).toMatchObject({type:'news',description:'登录并核验权限后查看扫码内容',url:`https://shop.example.test/#/pages/share/landing?q=${t}`});
    expect(JSON.stringify(reply)).not.toContain(MEMBER_CODE);expect(await service.referrer(scene,'owned-private-image-ticket')).toBe(0);
    expect(await service.news(scene,'another-private-ticket')).toBeNull();
  });
  it.each(['routine_appId','wechat_appid'] as const)('rejects committed %s rotation at the real provider method boundary before contacting either provider',async key=>{
    config.set(`cfg_${key}`,'foreign-stale-provider-app');
    const service=new LegacyShareCodeService(createContainerFromDb(f.db),env,fetcher);
    const originalOfficial=OfficialAccountQrcodeService.prototype.requestLegacyShare;
    const originalMini=WechatMiniProgramCodeService.prototype.createLegacyShareLandingDataUrl;
    // Commit a real account change after the descriptor snapshot and before
    // the provider's fresh credential snapshot. Both spies invoke the actual
    // implementation; stale KV is deliberately irrelevant to this boundary.
    const rotation=key==='wechat_appid'?vi.spyOn(OfficialAccountQrcodeService.prototype,'requestLegacyShare').mockImplementation(async function(this:OfficialAccountQrcodeService,...args:Parameters<typeof originalOfficial>){
      await f.db.update(systemConfig).set({value:'"rotated-private-official"'}).where(eq(systemConfig.menuName,'wechat_appid'));
      return originalOfficial.apply(this,args);
    }):vi.spyOn(WechatMiniProgramCodeService.prototype,'createLegacyShareLandingDataUrl').mockImplementation(async function(this:WechatMiniProgramCodeService,...args:Parameters<typeof originalMini>){
      await f.db.update(systemConfig).set({value:'"rotated-private-mini"'}).where(eq(systemConfig.menuName,'routine_appId'));
      return originalMini.apply(this,args);
    });
    try{
      await expect(service.code(input(90),actor(),key==='wechat_appid')).rejects.toThrow('账户配置已变化');
      expect(rotation).toHaveBeenCalledOnce();expect(requests).toEqual([]);
      expect((await f.db.select({value:systemConfig.value}).from(systemConfig).where(eq(systemConfig.menuName,key)))[0].value)
        .toBe(JSON.stringify(key==='wechat_appid'?'rotated-private-official':'rotated-private-mini'));
    }finally{rotation.mockRestore();}
  });
  it('ignores stale official and routine KV and generates both images with their current SQL accounts',async()=>{
    config.set('cfg_wechat_appid','foreign-stale-provider-app');config.set('cfg_wechat_appsecret','foreign-stale-provider-secret');
    config.set('cfg_routine_appId','foreign-stale-mini-app');config.set('cfg_routine_appsecret','foreign-stale-mini-secret');
    const get=vi.spyOn(env.CONFIG_KV,'get');
    try{
      const service=new LegacyShareCodeService(createContainerFromDb(f.db),env,fetcher),result=await service.code(input(90),actor(),true);
      expect(result.wechatUrl).not.toBe('');expect(result.routineUrl).not.toBe('');
      const official=requests.find(value=>new URL(value.url).pathname==='/cgi-bin/token'&&new URL(value.url).searchParams.get('appid')==='owned-private-official');
      expect(official).toBeDefined();expect(new URL(official!.url).searchParams.get('secret')).toBe('private-official-secret');
      const mini=requests.find(value=>new URL(value.url).pathname==='/cgi-bin/token'&&new URL(value.url).searchParams.get('appid')==='owned-private-mini');
      expect(mini).toBeDefined();expect(new URL(mini!.url).searchParams.get('secret')).toBe('private-mini-secret');
      expect(JSON.stringify(requests)).not.toContain('foreign-stale-provider');
      expect(JSON.stringify(requests)).not.toContain('foreign-stale-mini');
      expect(get.mock.calls.map(call=>call[0])).not.toContain('cfg_wechat_appid');expect(get.mock.calls.map(call=>call[0])).not.toContain('cfg_wechat_appsecret');
      expect(get.mock.calls.map(call=>call[0])).not.toContain('cfg_routine_appId');expect(get.mock.calls.map(call=>call[0])).not.toContain('cfg_routine_appsecret');
      expect(requests.some(value=>new URL(value.url).pathname==='/wxa/getwxacodeunlimit')).toBe(true);
    }finally{get.mockRestore();}
  });
  it('keeps configured-but-incomplete mini generation pending and recovers with its known ticket and saved official image',async()=>{
    await f.db.update(systemConfig).set({value:'""'}).where(eq(systemConfig.menuName,'routine_appsecret'));
    const service=new LegacyShareCodeService(createContainerFromDb(f.db),env,fetcher);
    await expect(service.code(input(90),actor(),true)).rejects.toThrow('生成失败');
    const rows=await f.db.select().from(legacyCache),pending=rows.map(row=>JSON.parse(row.result??'null')).find(value=>value?.state==='pending');
    expect(rows.filter(row=>row.key.startsWith('lshare:'))).toEqual([]);
    expect(pending).toMatchObject({officialTicket:'owned-private-image-ticket',state:'pending'});
    expect(pending.images.wechat.mime).toBe('image/png');expect(pending.images.routine).toBeUndefined();
    await f.db.update(systemConfig).set({value:'"repaired-private-mini-secret"'}).where(eq(systemConfig.menuName,'routine_appsecret'));
    config.delete('cfg_routine_appsecret');
    const clock=vi.spyOn(Date,'now').mockReturnValue((pending.leaseUntil+1)*1000);
    try{
      const result=await service.code(input(90),actor(),true);
      expect(token(result.routineUrl)).toBe(pending.token);expect(token(result.wechatUrl)).toBe(pending.token);
      expect(requests.filter(value=>value.url.includes('/cgi-bin/qrcode/create'))).toHaveLength(1);
      expect(requests.filter(value=>new URL(value.url).hostname==='mp.weixin.qq.com')).toHaveLength(1);
      expect(requests.filter(value=>value.url.includes('/wxa/getwxacodeunlimit'))).toHaveLength(1);
      const image=await service.image(pending.token,'routine',new URL(result.routineUrl,'https://api.example.test').searchParams);
      expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    }finally{clock.mockRestore();}
  });
});
