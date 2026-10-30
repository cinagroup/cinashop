import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createContainerFromDb} from '../src/lib/di';
import {systemConfig} from '../src/models/schema';
import {financeMemoryPostgres} from './helpers/financePostgres';
import type {Env} from '../src/env';
import {createProductShareScene,verifyProductShareScene,PRODUCT_SHARE_TTL_SECONDS} from '../src/services/product/ProductShareScene';
import {boundedProductShareFetch} from '../src/services/wechat/ProductShareProviderPolicy';
import {OfficialAccountQrcodeService} from '../src/services/wechat/OfficialAccountQrcodeService';
import {WechatMiniProgramCodeService} from '../src/services/wechat/WechatMiniProgramCodeService';
const key='owned-product-sharing-test-key',now=1800000000,png=new Uint8Array([137,80,78,71,13,10,26,10]);
function env(officialReads?:string[]){const entries=new Map(Object.entries({cfg_wechat_appid:officialReads?'stale-official-app':'official-app',cfg_wechat_appsecret:officialReads?'stale-official-secret':'private-official-secret'}));return {APP_KEY:key,UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',CONFIG_KV:{get:async(name:string)=>{officialReads?.push(name);if(name==='cfg_routine_appId'||name==='cfg_routine_appsecret')throw Error('Mini credentials must come from fresh SQL');return entries.get(name)??null;},put:async()=>{},delete:async()=>{}}} as unknown as Env;}
describe('bounded authenticated product sharing providers',()=>{
  let mini: Awaited<ReturnType<typeof financeMemoryPostgres>>;
  beforeAll(async()=>{mini=await financeMemoryPostgres([systemConfig]);await mini.db.insert(systemConfig).values([
    {menuName:'routine_appId',value:'"mini-app"'},{menuName:'routine_appsecret',value:'"private-mini-secret"'},
  ]);},30000);
  afterAll(async()=>{await mini?.close();},30000);
  it('uses a provider-sized HMAC scene for the exact product and authenticated referrer',async()=>{const scene=await createProductShareScene(2147483647,2147483647,key,now);expect(new TextEncoder().encode(scene).length).toBeLessThanOrEqual(64);expect(await verifyProductShareScene(scene,key,now)).toEqual({id:2147483647,uid:2147483647,expires:now+PRODUCT_SHARE_TTL_SECONDS});});
  it('rejects product/referrer/key/expiry/signature tampering and expired or excessively future scenes',async()=>{const scene=await createProductShareScene(70,11,key,now);for(const value of[scene.replace('p:70:11','p:71:11'),scene.replace('p:70:11','p:70:12'),scene.slice(0,-1)+(scene.endsWith('a')?'b':'a'),'p:0:11:1:'+'a'.repeat(24),'qrscene_'+scene])expect(await verifyProductShareScene(value,key,now)).toBeNull();expect(await verifyProductShareScene(scene,'wrong',now)).toBeNull();expect(await verifyProductShareScene(scene,key,now+PRODUCT_SHARE_TTL_SECONDS)).toBeNull();expect(await verifyProductShareScene(scene,key,now-1)).toBeNull();await expect(createProductShareScene(0,11,key,now)).rejects.toThrow();});
  it('pins the provider endpoint and applies a real deadline and redirect rejection',async()=>{const calls:RequestInit[]=[];const fetcher=async(_input:RequestInfo|URL,init?:RequestInit)=>{calls.push(init!);return Response.json({ok:1});};const load=boundedProductShareFetch(fetcher);await load('https://api.weixin.qq.com/cgi-bin/token');expect(calls[0].signal).toBeInstanceOf(AbortSignal);expect(calls[0].redirect).toBe('error');await expect(load('https://evil.example.com/cgi-bin/token')).rejects.toThrow();await expect(load('https://api.weixin.qq.com/other')).rejects.toThrow();expect(calls).toHaveLength(1);});
  it('cancels an oversized streamed body even without Content-Length',async()=>{let canceled=false;const load=boundedProductShareFetch(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(65537));},cancel(){canceled=true;}}),{headers:{'Content-Type':'application/json'}}));await expect(load('https://api.weixin.qq.com/cgi-bin/token')).rejects.toThrow('过大');expect(canceled).toBe(true);});
  it('rejects disguised HTML, unknown image MIME and malformed PNG instead of drawing it',async()=>{for(const[type,bytes]of[['text/html',new TextEncoder().encode('<script>secret</script>')],['image/svg+xml',new TextEncoder().encode('<svg/>')],['image/png',new Uint8Array([1,2,3])]] as const){const load=boundedProductShareFetch(async()=>new Response(bytes,{headers:{'Content-Type':type}}));await expect(load('https://api.weixin.qq.com/wxa/getwxacodeunlimit')).rejects.toThrow();}});
  it('refreshes an expired official token once and creates a temporary signed scene with the real showqrcode image',async()=>{
    const f=await financeMemoryPostgres([systemConfig]);
    try{
      await f.db.insert(systemConfig).values([{menuName:'wechat_appid',value:'"official-app"'},
        {menuName:'wechat_appsecret',value:'"private-official-secret"'}]);
      const reads:string[]=[],current=env(reads);
      const calls:{url:string;init?:RequestInit}[]=[],scene=await createProductShareScene(70,11,key,now);
      const fetcher=async(input:RequestInfo|URL,init?:RequestInit)=>{calls.push({url:String(input),init});if(calls.length===1||calls.length===3)return Response.json({access_token:'owned-token-'+calls.length,expires_in:7200});if(calls.length===2)return Response.json({errcode:40001});return Response.json({ticket:'owned+ticket',expire_seconds:2592000,url:'https://weixin.qq.com/q/owned'});};
      expect(await new OfficialAccountQrcodeService(createContainerFromDb(f.db),current,fetcher).requestTemporaryProduct(scene)).toBe('https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=owned%2Bticket');
      expect(calls).toHaveLength(4);
      for(const i of[1,3])expect(JSON.parse(String(calls[i].init?.body))).toEqual({expire_seconds:2592000,action_name:'QR_STR_SCENE',action_info:{scene:{scene_str:scene}}});
      for(const i of[0,2]){expect(new URL(calls[i].url).searchParams.get('appid')).toBe('official-app');expect(new URL(calls[i].url).searchParams.get('secret')).toBe('private-official-secret');}
      expect(reads).not.toContain('cfg_wechat_appid');expect(reads).not.toContain('cfg_wechat_appsecret');
      expect(JSON.stringify(calls)).not.toContain('stale-official');
    }finally{await f.close();}
  },30000);
  it('creates the current registered mini-program page with the real authenticated referrer',async()=>{const calls:{url:string;init?:RequestInit}[]=[];const fetcher=async(input:RequestInfo|URL,init?:RequestInit)=>{calls.push({url:String(input),init});return calls.length===1?Response.json({access_token:'owned-token',expires_in:7200}):new Response(png,{headers:{'Content-Type':'image/png'}});};expect(await new WechatMiniProgramCodeService(createContainerFromDb(mini.db),env(),fetcher).createOrdinaryProductDataUrl(70,11)).toBe('data:image/png;base64,iVBORw0KGgo=');expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({page:'pages/goods/detail',scene:'id=70&spid=11',check_path:true,env_version:'release'});expect(calls).toHaveLength(2);expect(new URL(calls[0].url).searchParams.get('appid')).toBe('mini-app');expect(new URL(calls[0].url).searchParams.get('secret')).toBe('private-mini-secret');});
  it('rejects invalid or out-of-range identifiers before any HTTP',async()=>{let calls=0;const service=new WechatMiniProgramCodeService(createContainerFromDb(mini.db),env(),async()=>{calls++;throw Error('unused');});for(const[id,uid]of[[0,11],[70,0],[2147483648,11],[70,2147483648],[1.5,11],[70,Number.NaN]])await expect(service.createOrdinaryProductDataUrl(id,uid)).rejects.toThrow();expect(calls).toBe(0);});
});
