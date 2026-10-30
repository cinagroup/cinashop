import { Buffer } from 'node:buffer';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemConfig, user } from '@/models/schema';
import { readRoutineCredentials, readRoutineCredentialsIfConfigured, routineCredentialCacheKey } from '@/services/wechat/RoutineRuntimeConfig';
import { createAgentInviteSignature, WechatMiniProgramCodeService } from '@/services/wechat/WechatMiniProgramCodeService';
import { financePostgres } from './helpers/financePostgres';
import { outcome, withFinancePeers } from './helpers/financePeers';

const transport = vi.hoisted(() => {
  const state = { values: new Map<string, unknown>(), depth: 0, reads: [] as string[], writes: [] as string[], deletes: [] as string[],
    getHook: undefined as undefined | ((key: string) => Promise<void>),
    setHook: undefined as undefined | ((key: string) => Promise<void>) };
  const outside = () => { if (state.depth) throw Error('Provider/Redis/KV inside routine SQL transaction'); };
  const get = async (key: string) => { outside(); state.reads.push(key); const value = state.values.get(key) ?? null; await state.getHook?.(key); return value; };
  const set = async (key: string, value: unknown) => { outside(); state.writes.push(key); state.values.set(key, value); await state.setHook?.(key); return true; };
  const redis = { get, set: async (key: string, value: unknown) => { await set(key, value); return 'OK'; },
    del: async (key: string) => { outside(); state.deletes.push(key); return Number(state.values.delete(key)); } };
  return { state, outside, get, set, redis };
});
vi.mock('@/utils/cache', () => ({ cacheGet: transport.get, cacheSet: transport.set, getRedis: () => transport.redis }));
const APP = 'wx0000000000000001', SECRET = 'owned-qr-secret', PNG = new Uint8Array([137,80,78,71,13,10,26,10]);
const BASE64 = Buffer.from(PNG).toString('base64'), IMAGE = 'data:image/png;base64,' + BASE64;
const IP_KEY = 'owned-qr-signing-key';
const native = Boolean(process.env.TEST_FINANCE_POSTGRES_URL);
const barrier = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
type Flow = { name: string; run: (service: WechatMiniProgramCodeService) => Promise<unknown>; body: Record<string, unknown>; suffix?: string };
const flows: Flow[] = [
  { name: 'membership activation', run: s => s.createMembershipActivationDataUrl(), body: { path: 'pages/annex/vip_active/index' }, suffix: 'membership_activation' },
  { name: 'paid membership', run: s => s.createPaidMembershipDataUrl(), body: { path: 'pages/annex/vip_paid/index' }, suffix: 'paid_membership' },
  { name: 'offline cashier', run: s => s.createOfflineCashierDataUrl(), body: { path: 'pages/annex/offline_pay/index' }, suffix: 'offline_cashier_v1' },
  { name: 'legacy product detail', run: s => s.createProductDetailDataUrl(70), body: { page: 'pages/goods_details/index', scene: 'id=70&spid=0' }, suffix: 'product_detail:70' },
  { name: 'registered product/referrer', run: s => s.createOrdinaryProductDataUrl(70,7), body: { page: 'pages/goods/detail', scene: 'id=70&spid=7' } },
  ...([1,2,3,31] as const).map(type => ({ name: 'activity ' + type, run: (s: WechatMiniProgramCodeService) => s.createActivityDataUrl(type,70,7),
    body: type === 1 || type === 3 ? { page: 'pages/activity/goods_details/index', scene: `id=70&spid=7&type=${type}` }
      : { page: type === 2 ? 'pages/activity/goods_bargain_details/index' : 'pages/activity/goods_combination_status/index', scene: 'id=70&spid=7' }, suffix: `activity:${type}:70:7` })),
  { name: 'user spread', run: s => s.createUserSpreadDataUrl(7), body: { page: 'pages/users/user_spread_user/index', scene: '7' }, suffix: 'user_spread:7' },
  { name: 'opaque share landing', run: s => s.createLegacyShareLandingDataUrl('a'.repeat(24),APP), body: { page: 'pages/share/landing', scene: 'q=' + 'a'.repeat(24) } },
  { name: 'employee invite', run: s => s.createDivisionStaffInviteDataUrl(901,APP), body: { page: 'pages/users/agent/bind', scene: 'a=901' } },
  { name: 'signed agent image', run: async s => { const expires = Math.floor(Date.now()/1000)+600; return s.renderAgentInviteCode(7,expires,await createAgentInviteSignature(7,expires,IP_KEY)); }, body: { page: 'pages/users/user_spread_user/index', scene: '7' }, suffix: 'division_agent:7' },
];

describe('routine QR consumers use fresh paired SQL source and isolate image publication', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, env: Env;
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  const calls: Array<{ url: URL; body: Record<string, unknown> | null }> = [];
  function observed(db: DbClient): DbClient {
    return new Proxy(db, { get(target, property, receiver) {
      const method: unknown = Reflect.get(target,property,receiver);
      if (typeof method !== 'function') return method;
      if (property !== 'transaction') return method.bind(target);
      return (...args: unknown[]) => Reflect.apply(method,target,[async (tx: DbClient) => {
        transport.state.depth++; try { return await (args[0] as (tx: DbClient) => Promise<unknown>)(observed(tx)); }
        finally { transport.state.depth--; }
      },...args.slice(1)]);
    } });
  }
  const container = () => createContainerFromDb(observed(f.db));
  const service = () => new WechatMiniProgramCodeService(container(),env,fetcher);
  const current = () => readRoutineCredentials(container(),env);
  const rotate = () => f.db.update(systemConfig).set({ value: '"owned-next-secret"' }).where(eq(systemConfig.id,2));
  const codeKey = (stamp: string, suffix = 'paid_membership') => `routine_code:v2:${stamp}:${suffix}`;
  const record = (stamp: string) => ({ version: 2, stamp, contentType: 'image/png', base64: BASE64 });
  const rights = () => f.db.select().from(user).orderBy(user.uid);
  beforeAll(async () => { f = await financePostgres([systemConfig,user],{namespace:'public'}); },30_000);
  afterAll(async () => { await f?.close(); },30_000);
  beforeEach(async () => {
    vi.restoreAllMocks(); transport.state.values.clear(); transport.state.reads.length=0; transport.state.writes.length=0; transport.state.deletes.length=0;
    transport.state.depth=0; transport.state.getHook=undefined; transport.state.setHook=undefined; calls.length=0;
    await f.reset();
    await f.db.insert(systemConfig).values([{id:1,menuName:'routine_appId',value:JSON.stringify(APP),sort:5},
      {id:2,menuName:'routine_appsecret',value:JSON.stringify(SECRET),sort:5}, {id:3,menuName:'routine_appsecret',value:'owned-shadow',sort:-1}]);
    await f.db.insert(user).values({uid:7,status:1,divisionType:2,divisionStatus:1,nowMoney:'25.00',integral:81,level:2,levelStatus:1});
    env={APP_KEY:IP_KEY,CONFIG_KV:{get:vi.fn(async()=>{transport.outside();throw Error('Credential KV fallback forbidden');}),put:vi.fn(),delete:vi.fn()}} as unknown as Env;
    fetcher=vi.fn(async(input,init)=>{transport.outside();const url=new URL(String(input));calls.push({url,body:init?.body?JSON.parse(String(init.body)):null});
      expect(init?.redirect).toBe('error');expect(init?.signal).toBeInstanceOf(AbortSignal);
      return url.pathname==='/cgi-bin/token'?Response.json({access_token:'owned-qr-token',expires_in:7200}):new Response(PNG,{headers:{'Content-Type':'image/png'}});
    });
  });
  afterEach(()=>{expect(transport.state.depth).toBe(0);expect(env.CONFIG_KV.get).not.toHaveBeenCalled();vi.useRealTimers();vi.restoreAllMocks();});

  it.each(flows)('preserves $name page/scene while reading one SQL source and leaving old rights unchanged',async flow=>{
    const credentials=await current(),before=await rights();
    transport.state.values.set(`routine_access_token:${APP}`,'legacy-token');transport.state.values.set('routine_access_token','legacy-global');
    const result=await flow.run(service());
    if(result instanceof Response)expect(new Uint8Array(await result.arrayBuffer())).toEqual(PNG);else expect(result).toBe(IMAGE);
    expect(calls).toHaveLength(2);expect(calls[0].url.searchParams.get('appid')).toBe(APP);expect(calls[0].url.searchParams.get('secret')).toBe(SECRET);
    expect(calls[1].body).toMatchObject({...flow.body,check_path:true,env_version:'release',width:430});
    expect(transport.state.reads).not.toContain(`routine_access_token:${APP}`);expect(transport.state.reads).not.toContain('routine_access_token');
    if(flow.suffix)expect(transport.state.values.get(codeKey(credentials.stamp,flow.suffix))).toEqual(record(credentials.stamp));
    expect(await rights()).toEqual(before);
  });

  it('returns a validated current image cache hit without provider I/O or any legacy key read',async()=>{
    const credentials=await current();transport.state.values.set(codeKey(credentials.stamp),record(credentials.stamp));
    transport.state.values.set(`routine_code:paid_membership:${APP}`,{contentType:'image/png',base64:'old'});
    expect(await service().createPaidMembershipDataUrl()).toBe(IMAGE);expect(fetcher).not.toHaveBeenCalled();
    expect(transport.state.reads).toEqual([codeKey(credentials.stamp)]);expect(transport.state.writes).toEqual([]);
  });

  it.each([undefined,'a'.repeat(64)])('regenerates an image with absent or mismatched embedded stamp %s without adopting it',async stamp=>{
    const credentials=await current();transport.state.values.set(codeKey(credentials.stamp),{...record(credentials.stamp),stamp});
    expect(await service().createPaidMembershipDataUrl()).toBe(IMAGE);expect(calls).toHaveLength(2);
    expect(transport.state.values.get(codeKey(credentials.stamp))).toEqual(record(credentials.stamp));expect(transport.state.deletes).toEqual([]);
  });

  it.each(['winner','shadow','ABA'])('rejects a successful QR response after %s source rotation before image publication',async mode=>{
    const before=await rights(),original=fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async(input,init)=>{const response=await original(input,init);if(new URL(String(input)).pathname!=='/cgi-bin/token'){
      if(mode==='shadow')await f.db.update(systemConfig).set({info:'changed shadow'}).where(eq(systemConfig.id,3));
      else {await rotate();if(mode==='ABA')await f.db.update(systemConfig).set({value:JSON.stringify(SECRET)}).where(eq(systemConfig.id,2));}
    }return response;});
    await expect(service().createPaidMembershipDataUrl()).rejects.toThrow(/配置已变化|重新授权/u);
    expect(transport.state.writes.filter(k=>k.startsWith('routine_code:'))).toEqual([]);expect(await rights()).toEqual(before);
  });

  it('rejects a cached image read that crosses rotation without returning it or calling a provider',async()=>{
    const credentials=await current();transport.state.values.set(codeKey(credentials.stamp),record(credentials.stamp));
    transport.state.getHook=async key=>{if(key.startsWith('routine_code:'))await rotate();};
    await expect(service().createPaidMembershipDataUrl()).rejects.toThrow(/配置已变化|重新授权/u);expect(fetcher).not.toHaveBeenCalled();
  });

  it('a late image SET cannot return or delete a newer source cache entry',async()=>{
    const old=await current();let newerKey='';
    transport.state.setHook=async key=>{if(key.startsWith('routine_code:')){await rotate();newerKey=codeKey((await current()).stamp);transport.state.values.set(newerKey,{owned:'newer source'});}};
    await expect(service().createPaidMembershipDataUrl()).rejects.toThrow(/配置已变化|重新授权/u);
    expect(transport.state.values.get(codeKey(old.stamp))).toEqual(record(old.stamp));expect(transport.state.values.get(newerKey)).toEqual({owned:'newer source'});expect(transport.state.deletes).toEqual([]);
  });

  it('same-AppID Secret rotation and A-B-A cannot resurrect old token or image caches',async()=>{
    const first=await current();expect(await service().createPaidMembershipDataUrl()).toBe(IMAGE);
    await rotate();const second=await current();expect(await service().createPaidMembershipDataUrl()).toBe(IMAGE);
    await f.db.update(systemConfig).set({value:JSON.stringify(SECRET)}).where(eq(systemConfig.id,2));const third=await current();
    expect(await service().createPaidMembershipDataUrl()).toBe(IMAGE);
    expect(new Set([first.stamp,second.stamp,third.stamp]).size).toBe(3);expect(calls).toHaveLength(6);
    expect(calls.filter(c=>c.url.pathname==='/cgi-bin/token').map(c=>c.url.searchParams.get('secret'))).toEqual([SECRET,'owned-next-secret',SECRET]);
    for(const credentials of[first,second,third])expect(transport.state.values.get(codeKey(credentials.stamp))).toEqual(record(credentials.stamp));
  });

  it.each([40001,40014,42001])('retries invalid token %i exactly once with the same SQL pair and source namespace',async errcode=>{
    const credentials=await current(),original=fetcher.getMockImplementation()!;let images=0;
    fetcher.mockImplementation(async(input,init)=>{const response=await original(input,init);return new URL(String(input)).pathname!=='/cgi-bin/token'&&++images===1?Response.json({errcode}):response;});
    expect(await service().createPaidMembershipDataUrl()).toBe(IMAGE);expect(calls).toHaveLength(4);
    expect(calls.filter(c=>c.url.pathname==='/cgi-bin/token').map(c=>[c.url.searchParams.get('appid'),c.url.searchParams.get('secret')])).toEqual([[APP,SECRET],[APP,SECRET]]);
    expect(transport.state.deletes).toEqual([routineCredentialCacheKey(credentials,'access_token')]);
  });

  it('does not refresh an invalid token rejection under a different source',async()=>{
    const original=fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async(input,init)=>{const response=await original(input,init);if(new URL(String(input)).pathname!=='/cgi-bin/token'){await rotate();return Response.json({errcode:40001});}return response;});
    await expect(service().createPaidMembershipDataUrl()).rejects.toThrow(/配置已变化|重新授权/u);expect(calls).toHaveLength(2);expect(transport.state.deletes).toEqual([]);
  });

  it('treats only an incomplete fresh SQL pair as unconfigured, without adopting cached credentials',async()=>{
    await f.db.delete(systemConfig).where(eq(systemConfig.id,2));await f.db.delete(systemConfig).where(eq(systemConfig.id,3));
    expect(await readRoutineCredentialsIfConfigured(container(),env)).toBeNull();expect(await service().createPaidMembershipDataUrl()).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();expect(transport.state.reads).toEqual([]);
    await expect(readRoutineCredentials(container(),env)).rejects.toThrow('凭据未完整配置');
  });

  it('does not mask missing signing key or source-capacity failures as an unconfigured feature',async()=>{
    env.APP_KEY='';await expect(service().createPaidMembershipDataUrl()).rejects.toThrow('签名');env.APP_KEY=IP_KEY;
    await f.db.insert(systemConfig).values(Array.from({length:62},(_,i)=>({id:100+i,menuName:'routine_appsecret',value:'shadow',sort:-2})));
    await expect(service().createPaidMembershipDataUrl()).rejects.toThrow('容量');expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['employee','landing'])('refuses a %s operation whose expected AppID differs before provider I/O',async mode=>{
    const request=mode==='employee'?service().createDivisionStaffInviteDataUrl(901,'other-app'):service().createLegacyShareLandingDataUrl('a'.repeat(24),'other-app');
    await expect(request).rejects.toThrow(/账户.*变化/u);expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['fetch','body'])('bounds QR %s even when the controlled provider ignores abort',async mode=>{
    const entered=barrier(),original=fetcher.getMockImplementation()!;let canceled=false;
    fetcher.mockImplementation(async(input,init)=>{if(new URL(String(input)).pathname==='/cgi-bin/token')return original(input,init);
      transport.outside();entered.resolve();if(mode==='fetch')return new Promise<Response>(()=>{});
      return new Response(new ReadableStream({start(controller){controller.enqueue(PNG);},cancel(){canceled=true;}}),{headers:{'Content-Type':'image/png'}});
    });
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const pending=outcome(service().createPaidMembershipDataUrl());
    await entered.promise;await vi.advanceTimersByTimeAsync(8_001);const result=await pending;
    expect(result.ok).toBe(false);if(mode==='body')expect(canceled).toBe(true);
    expect(transport.state.writes.filter(k=>k.startsWith('routine_code:'))).toEqual([]);
  });

  it.runIf(native)('PG16 maintenance gate rejects a late QR response without caching it or holding a transaction across HTTP',async()=>{
    const entered=barrier(),release=barrier(),original=fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async(input,init)=>{const response=await original(input,init);if(new URL(String(input)).pathname!=='/cgi-bin/token'){entered.resolve();await release.promise;}return response;});
    await withFinancePeers(f.db,async([owner])=>{
      const pending=outcome(service().createPaidMembershipDataUrl());
      try{await entered.promise;await owner.db.transaction(async tx=>{await tx.execute(sql`SELECT pg_advisory_xact_lock(731666,0)`);release.resolve();const result=await pending;expect(result.ok).toBe(false);});}
      finally{release.resolve();await pending;}
    });
    expect(transport.state.writes.filter(k=>k.startsWith('routine_code:'))).toEqual([]);
  });
});
