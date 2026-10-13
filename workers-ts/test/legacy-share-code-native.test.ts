import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { legacyCache, user, systemConfig, storeProduct, systemStore, systemSupplier,
  storeSeckill, storeSeckillTime, storeCombination, storeBargain, storeIntegral, storeNewcomer } from '@/models/schema';
import { LegacyShareCodeService, parseLegacyShareInput } from '@/services/other/LegacyShareCodeService';
import { md5 } from '@/utils/jwt';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';

type Fixture=Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type Reader=SequenceRunnerPeer & {role:string};
const password='owned-native-share-password',png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6JqkAAAAASUVORK5CYII=','base64');
const actor=()=>({uid:11,authVersion:md5(password),expiresAt:Math.floor(Date.now()/1000)+3600});
const input=()=>parseLegacyShareInput('0','70',new URLSearchParams());
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('legacy share cache leases and authority on independent PG16 LOGINs',()=>{
  let f:Fixture,ddl:string,env:Env;
  beforeAll(async()=>{const kit=await import('drizzle-kit/api');ddl=(await kit.generateMigration(kit.generateDrizzleJson({}),kit.generateDrizzleJson({legacyCache,user,systemConfig,storeProduct,systemStore,systemSupplier,storeSeckill,storeSeckillTime,storeCombination,storeBargain,storeIntegral,storeNewcomer}))).join('\n');});
  beforeEach(async()=>{
    f=await sequenceRunnerDatabase();if(f.format!=='pg16'||!f.withRuntimeRole||!f.withPeer)throw Error('Share cache proof requires PG16 independent LOGINs');
    await f.exec(ddl);await f.db.insert(user).values({uid:11,account:'native-share',pwd:password,nickname:'本机推广用户'});
    await f.db.insert(storeProduct).values({id:70,storeName:'本机商品',isShow:1,isDel:0,isVerify:1});
    await f.db.insert(systemConfig).values([{menuName:'site_name',value:'"本机商店"'},{menuName:'share_qrcode',value:'0'},
      {menuName:'routine_appId',value:'"owned-mini"'},{menuName:'routine_appsecret',value:'"owned-mini-secret"'},
      {menuName:'wechat_appid',value:'"owned-official"'},{menuName:'wechat_appsecret',value:'"owned-official-secret"'}]);
    await f.db.insert(legacyCache).values({key:'unrelated-fixture-cache',result:'owned-other-module-row'});
    env={APP_KEY:'owned-native-share-key',PUBLIC_H5_ORIGIN:'https://shop.example.test',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',CONFIG_KV:{get:async()=>null,put:async()=>{},delete:async()=>{}}} as unknown as Env;
  },60000);
  afterEach(async()=>{vi.restoreAllMocks();await f?.close();},30000);
  async function reader<T>(run:(peer:Reader)=>Promise<T>){return f.withRuntimeRole!(async peer=>{
    if(!/^cinashop_runtime_[a-f0-9]{32}$/.test(peer.role))throw Error('Unsafe owned share LOGIN');
    await f.exec(`GRANT SELECT ON public.cache,public.user,public.system_config,public.store_product,public.system_store,public.system_supplier,public.store_seckill,public.store_seckill_time,public.store_combination,public.store_bargain,public.store_integral,public.store_newcomer TO "${peer.role}";
      GRANT INSERT,UPDATE ON public.cache TO "${peer.role}"`);
    const [identity]=await peer.exec('SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_database() AS database');
    expect(identity).toMatchObject({role:peer.role,session:peer.role,pid:peer.pid});return run(peer);
  });}
  it('makes the claim visible to a second LOGIN while the provider runs outside SQL, then replays the single complete artifact',async()=>{
    await reader(first=>reader(async second=>{
      expect(first.pid).not.toBe(second.pid);let started!:()=>void,release!:(value:Response)=>void,calls=0;
      const atProvider=new Promise<void>(resolve=>{started=resolve;}),providerReply=new Promise<Response>(resolve=>{release=resolve;});
      const fetcher:typeof fetch=async target=>{calls++;if(new URL(String(target)).pathname==='/cgi-bin/token')return Response.json({access_token:'owned-token',expires_in:7200});
        const [state]=await first.exec("SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation");
        expect(state).toEqual({readonly:'off',isolation:'read committed'});started();return providerReply;};
      const one=new LegacyShareCodeService(createContainerFromDb(first.db),env,fetcher),two=new LegacyShareCodeService(createContainerFromDb(second.db),env,async()=>{throw Error('Second LOGIN must not call provider');});
      const pending=one.code(input(),actor(),false);await atProvider;
      await expect(two.code(input(),actor(),false)).rejects.toThrow('正在生成');
      release(new Response(png,{headers:{'Content-Type':'image/png'}}));const result=await pending;
      expect(calls).toBe(2);expect((await two.code(input(),actor(),false)).wechatUrl.split('?')[0]).toBe(result.wechatUrl.split('?')[0]);
      const own=await f.db.select().from(legacyCache);expect(own.filter(row=>row.key.startsWith('lshare:'))).toHaveLength(1);
      expect(own.find(row=>row.key==='unrelated-fixture-cache')?.result).toBe('owned-other-module-row');
      expect((await f.db.select().from(storeProduct))[0]).toMatchObject({isShow:1,isDel:0});
    }));
  },60000);
  it('rejects an independent product revocation committed while a provider is pending and never publishes that artifact',async()=>{
    await reader(peer=>f.withPeer!(async writer=>{
      let started!:()=>void,release!:(value:Response)=>void;const gate=new Promise<void>(resolve=>{started=resolve;}),reply=new Promise<Response>(resolve=>{release=resolve;});
      const fetcher:typeof fetch=async target=>new URL(String(target)).pathname==='/cgi-bin/token'?Response.json({access_token:'owned-token',expires_in:7200}):(started(),reply);
      const service=new LegacyShareCodeService(createContainerFromDb(peer.db),env,fetcher),pending=service.code(input(),actor(),false);
      const rejected=expect(pending).rejects.toThrow('不存在');await gate;await writer.db.update(storeProduct).set({isShow:0}).where(eq(storeProduct.id,70));
      release(new Response(png,{headers:{'Content-Type':'image/png'}}));await rejected;
      expect((await f.db.select().from(legacyCache)).filter(row=>row.key.startsWith('lshare:'))).toEqual([]);
      await expect(service.code(input(),actor(),false)).rejects.toThrow('不存在');
    }));
  },60000);
  it('checkpoints a known official ticket before image failure and resumes it without issuing another ticket',async()=>{
    await f.db.update(systemConfig).set({value:'1'}).where(eq(systemConfig.menuName,'share_qrcode'));
    await reader(async peer=>{
      let creates=0,failImage=true;
      const fetcher:typeof fetch=async target=>{const url=new URL(String(target));if(url.pathname==='/cgi-bin/token')return Response.json({access_token:'owned-token',expires_in:7200});
        if(url.pathname==='/cgi-bin/qrcode/create'){creates++;return Response.json({ticket:'durable-owned-ticket'});}
        if(url.hostname==='mp.weixin.qq.com'&&failImage)throw Error('Owned image response lost');return new Response(png,{headers:{'Content-Type':'image/png'}});};
      const service=new LegacyShareCodeService(createContainerFromDb(peer.db),env,fetcher);await expect(service.code(input(),actor(),true)).rejects.toThrow('生成失败');
      const rows=await f.db.select().from(legacyCache),document=rows.map(row=>{try{return JSON.parse(row.result??'null');}catch{return null;}}).find(value=>value?.state==='pending');
      expect(document.officialTicket).toBe('durable-owned-ticket');expect(creates).toBe(1);failImage=false;
      const clock=vi.spyOn(Date,'now').mockReturnValue((document.leaseUntil+1)*1000);
      try {const ready=await service.code(input(),actor(),true);expect(ready.wechatUrl).toContain(document.token);expect(creates).toBe(1);}
      finally{clock.mockRestore();}
    });
  },60000);
});
