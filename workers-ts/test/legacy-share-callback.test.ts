import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { agentLevel, agentLevelTask, agentLevelTaskRecord, legacyCache, luckLottery, qrcode,
  storeOrder, storeProduct, systemConfig, systemStore, systemSupplier, user, userFriends, userSpread,
  wechatQrcode, wechatUser, type WechatCallbackEvent } from '@/models/schema';
import { LegacyShareCodeService, parseLegacyShareInput } from '@/services/other/LegacyShareCodeService';
import { WechatCallbackService } from '@/services/wechat/WechatCallbackService';
import { normalizeWechatCallback } from '@/services/wechat/WechatCallbackCrypto';
import { md5 } from '@/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

const tables = [agentLevel, agentLevelTask, agentLevelTaskRecord, legacyCache, luckLottery, qrcode,
  storeOrder, storeProduct, systemConfig, systemStore, systemSupplier, user, userFriends, userSpread, wechatQrcode, wechatUser];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6JqkAAAAASUVORK5CYII=','base64');

describe('legacy signed official callback target and mature permanent referral effect', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, env: Env, service: LegacyShareCodeService, callback: WechatCallbackService;
  const config = new Map<string,string>();
  const network = vi.fn(async (target: RequestInfo | URL) => {
    const url = new URL(String(target));
    if (url.pathname === '/cgi-bin/token') return Response.json({ access_token:'owned-callback-token',expires_in:7200 });
    if (url.pathname === '/cgi-bin/qrcode/create') return Response.json({ ticket:'owned-callback-ticket' });
    if (url.hostname === 'mp.weixin.qq.com') return new Response(png,{headers:{'Content-Type':'image/png'}});
    throw Error('Uncontrolled callback fixture provider');
  });
  beforeAll(async () => { f = await financePostgres(tables); },30000);
  beforeEach(async () => {
    await f.reset(); network.mockClear(); config.clear();
    env = { APP_KEY:'owned-callback-share-key',PUBLIC_H5_ORIGIN:'https://shop.example.test',
      UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',CONFIG_KV:{ get:async(key:string)=>config.get(key)??null,
        put:async(key:string,value:string)=>{config.set(key,value);},delete:async(key:string)=>{config.delete(key);} } } as unknown as Env;
    const container=createContainerFromDb(f.db);service=new LegacyShareCodeService(container,env,network);callback=new WechatCallbackService(container,env);
    await f.db.insert(user).values([{uid:11,pwd:'owned-spread-password',nickname:'真实推广人'}, {uid:12}, {uid:13}]);
    await f.db.insert(wechatUser).values({uid:12,openid:'owned-subscriber',userType:'wechat'});
    await f.db.insert(storeProduct).values({id:70,storeName:'当前真实商品',isShow:1,isDel:0,isVerify:1});
    await f.db.insert(systemConfig).values([{menuName:'site_name',value:'"本机商店"'}, {menuName:'share_qrcode',value:'1'},
      {menuName:'wechat_appid',value:'"owned-callback-official"'}, {menuName:'wechat_appsecret',value:'"owned-callback-secret"'},
      {menuName:'create_wechat_user',value:'0'}]);
  });
  afterAll(async()=>{await f?.close();},30000);
  async function generate() {
    const result=await service.code(parseLegacyShareInput('0','70',new URLSearchParams()),
      {uid:11,authVersion:md5('owned-spread-password'),expiresAt:Math.floor(Date.now()/1000)+3600},true);
    const token=new URL(result.wechatUrl,'https://api.example.test').pathname.split('/')[5];
    const [row]=await f.db.select().from(legacyCache).where(eq(legacyCache.key,`lshare:${token}`));
    return {token,document:JSON.parse(row.result!)};
  }
  async function normalized(scene: string, ticket='owned-callback-ticket', kind='subscribe') {
    return normalizeWechatCallback(`<xml><ToUserName>official</ToUserName><FromUserName>owned-subscriber</FromUserName><CreateTime>${Math.floor(Date.now()/1000)}</CreateTime><MsgType>event</MsgType><Event>${kind}</Event><EventKey>${kind==='subscribe'?'qrscene_':''}${scene}</EventKey><Ticket>${ticket}</Ticket></xml>`,'official','owned-callback-official');
  }
  async function project(scene: string,ticket='owned-callback-ticket',kind='subscribe') {
    const n=await normalized(scene,ticket,kind);
    const event={...n,id:1,fromUser:n.payload.fromUser} as unknown as WechatCallbackEvent;
    return Reflect.get(callback,'prepareProjection').call(callback,event,kind==='subscribe'?'follow':'scan');
  }
  it('resolves an actual signed-ticket callback then binds the real openid owner once through bindSpread',async()=>{
    const {document,token}=await generate(),n=await normalized(document.scene),calls=network.mock.calls.length;
    expect(await Reflect.get(callback,'resolveReply').call(callback,n)).toMatchObject({type:'news',title:'当前真实商品',url:`https://shop.example.test/#/pages/share/landing?q=${token}`});
    expect(await project(document.scene)).toMatchObject({uid:12});
    await project(document.scene);await project(document.scene,'owned-callback-ticket','SCAN');
    expect((await f.db.select().from(user).where(eq(user.uid,12)))[0].spreadUid).toBe(11);
    expect((await f.db.select().from(user).where(eq(user.uid,11)))[0].spreadCount).toBe(1);
    expect(await f.db.select().from(userSpread)).toMatchObject([{uid:12,spreadUid:11}]);
    expect(await f.db.select().from(userFriends)).toMatchObject([{uid:12,friendsUid:11}]);
    expect(network).toHaveBeenCalledTimes(calls);
  });
  it('rejects another ticket, altered signature and a guessed bare UID without binding a referral',async()=>{
    const {document}=await generate();
    await project(document.scene,'foreign-ticket');
    await project(document.scene.slice(0,-1)+(document.scene.endsWith('0')?'1':'0'));
    await project('11');
    expect((await f.db.select().from(user).where(eq(user.uid,12)))[0].spreadUid).toBe(0);
    expect(await f.db.select().from(userSpread)).toEqual([]);expect(await f.db.select().from(userFriends)).toEqual([]);
  });
  it('rechecks the current product and real generation account before any callback binding',async()=>{
    const {document}=await generate();
    await f.db.update(storeProduct).set({isShow:0}).where(eq(storeProduct.id,70));await project(document.scene);
    await f.db.update(storeProduct).set({isShow:1}).where(eq(storeProduct.id,70));
    await f.db.update(user).set({status:0}).where(eq(user.uid,11));await project(document.scene);
    expect((await f.db.select().from(user).where(eq(user.uid,12)))[0].spreadUid).toBe(0);
    expect(await f.db.select().from(userSpread)).toEqual([]);
  });
});
