import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { createContainerFromDb, createDbFromConnectionString } from '../src/lib/di';
import { WechatMiniProgramCodeService } from '../src/services/wechat/WechatMiniProgramCodeService';
import { boundedOfflineCodeFetch } from '../src/services/order/OfflineScanCode';
import { cacheGet, cacheSet, cacheDelete } from '../src/utils/cache';
vi.mock('../src/utils/cache', () => ({cacheGet:vi.fn(),cacheSet:vi.fn(),cacheDelete:vi.fn()}));
const raw = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const key = 'routine_code:offline_cashier_v1:synthetic-app';
describe('offline mini-program cache admission', () => {
  // Lazy SQL client is never used: these tests isolate the adapter/cache contract.
  const db = createDbFromConnectionString('postgresql://unused:unused@127.0.0.1:1/not_contacted',1);
  const container = createContainerFromDb(db);
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(cacheSet).mockResolvedValue(true); vi.mocked(cacheDelete).mockResolvedValue(true);
    vi.spyOn(container.systemConfigDao,'getValues').mockRejectedValue(Error('unexpected SQL'));
  });
  afterEach(async () => {vi.restoreAllMocks(); await db.$client.end();});
  const run = async (fetcher:typeof fetch, values = {cfg_routine_appId:'synthetic-app',cfg_routine_appsecret:'synthetic-secret'}) => {
    const app = new Hono<{Bindings:Env}>(); let result: string|null|undefined;
    app.onError(error => {throw error;});
    app.get('/',async c => {result=await new WechatMiniProgramCodeService(container,c.env,boundedOfflineCodeFetch(fetcher)).createOfflineCashierDataUrl();return c.body(null,204);});
    await app.request('/',{}, {APP_KEY:'synthetic-app-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',
      CONFIG_KV:{get:async(key:string)=>Object.entries(values).find(([k])=>k===key)?.[1]??null,put:async()=>{},delete:async()=>{}}});
    expect(container.systemConfigDao.getValues).not.toHaveBeenCalled();
    return result;
  };
  it('validated cached code returns without provider I/O', async () => {
    vi.mocked(cacheGet).mockImplementation(async k => k===key ? {contentType:'image/png',base64:raw}:null);
    const fetcher=vi.fn<typeof fetch>();
    expect(await run(fetcher)).toBe('data:image/png;base64,'+raw);
    expect(fetcher).not.toHaveBeenCalled(); expect(cacheSet).not.toHaveBeenCalled();
  });
  it('invalid cached image is removed and replaced only with validated provider data', async () => {
    vi.mocked(cacheGet).mockImplementation(async k => k===key ? {contentType:'image/svg+xml',base64:'PHN2Zz4='}:'synthetic-token');
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(Buffer.from(raw,'base64'),{headers:{'Content-Type':'image/png'}}));
    expect(await run(fetcher)).toBe('data:image/png;base64,'+raw);
    expect(cacheDelete).toHaveBeenCalledWith(key,expect.anything()); expect(fetcher).toHaveBeenCalledOnce();
    expect(cacheSet).toHaveBeenCalledWith(key,{contentType:'image/png',base64:raw},expect.anything(),604800);
  });
  it('active or malformed provider images never enter the seven-day cache', async () => {
    vi.mocked(cacheGet).mockImplementation(async k => k===key ? null:'synthetic-token');
    for (const [mime,body] of [['image/svg+xml','<svg/>'],['image/png','not a PNG']]) {
      await expect(run(async()=>new Response(body,{headers:{'Content-Type':mime}}))).rejects.toThrow();
    }
    expect(cacheSet).not.toHaveBeenCalled();
  });
  it('missing credentials never consume a cached code or call the provider', async () => {
    const fetcher=vi.fn<typeof fetch>();
    expect(await run(fetcher,{cfg_routine_appId:'',cfg_routine_appsecret:''})).toBeNull();
    expect(cacheGet).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
});
