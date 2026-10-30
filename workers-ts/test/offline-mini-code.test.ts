import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { systemConfig } from '../src/models/schema';
import { readRoutineCredentials, routineCredentialCacheKey } from '../src/services/wechat/RoutineRuntimeConfig';
import { financeMemoryPostgres } from './helpers/financePostgres';
import { WechatMiniProgramCodeService } from '../src/services/wechat/WechatMiniProgramCodeService';
import { boundedOfflineCodeFetch } from '../src/services/order/OfflineScanCode';
import { cacheGet, cacheSet, cacheDelete } from '../src/utils/cache';
const redis = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() }));
vi.mock('../src/utils/cache', () => ({cacheGet:vi.fn(),cacheSet:vi.fn(),cacheDelete:vi.fn(),getRedis:()=>redis}));
const raw = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
describe('offline mini-program cache admission', () => {
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>;
  let key: string, stamp: string;
  const runtime = { APP_KEY: 'synthetic-app-key' };
  const kvGet = vi.fn(async () => { throw Error('Mini credentials must come from the actual SQL fixture'); });
  beforeAll(async () => { f = await financeMemoryPostgres([systemConfig]); }, 30_000);
  afterAll(async () => { await f?.close(); }, 30_000);
  beforeEach(async () => {
    vi.clearAllMocks();
    await f.reset();
    await f.db.insert(systemConfig).values([
      { id: 1, menuName: 'routine_appId', value: '"synthetic-app"' },
      { id: 2, menuName: 'routine_appsecret', value: '"synthetic-secret"' },
    ]);
    const credentials = await readRoutineCredentials(createContainerFromDb(f.db), runtime);
    stamp = credentials.stamp; key = `routine_code:v2:${stamp}:offline_cashier_v1`;
    redis.get.mockImplementation(async candidate => {
      expect(candidate).toBe(routineCredentialCacheKey(credentials, 'access_token'));
      return { version: 1, token: 'synthetic-token', expiresAt: Date.now() + 3600000 };
    });
    redis.set.mockResolvedValue('OK'); redis.del.mockResolvedValue(1);
    vi.mocked(cacheGet).mockResolvedValue(null);
    vi.mocked(cacheSet).mockResolvedValue(true); vi.mocked(cacheDelete).mockResolvedValue(true);
  });
  afterEach(() => { expect(kvGet).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  const run = async (fetcher:typeof fetch, configured = true) => {
    if (!configured) await f.db.update(systemConfig).set({ value: '""' }).where(eq(systemConfig.id, 2));
    const container = createContainerFromDb(f.db);
    const app = new Hono<{Bindings:Env}>(); let result: string|null|undefined;
    app.onError(error => {throw error;});
    app.get('/',async c => {result=await new WechatMiniProgramCodeService(container,c.env,boundedOfflineCodeFetch(fetcher)).createOfflineCashierDataUrl();return c.body(null,204);});
    await app.request('/',{}, {APP_KEY:'synthetic-app-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',
      CONFIG_KV:{get:kvGet,put:async()=>{},delete:async()=>{}}});
    return result;
  };
  it('validated cached code returns without provider I/O', async () => {
    vi.mocked(cacheGet).mockImplementation(async k => k===key ? {version:2,stamp,contentType:'image/png',base64:raw}:null);
    const fetcher=vi.fn<typeof fetch>();
    expect(await run(fetcher)).toBe('data:image/png;base64,'+raw);
    expect(fetcher).not.toHaveBeenCalled(); expect(cacheSet).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
  });
  it('invalid cached image is treated as a miss and replaced only with validated provider data', async () => {
    vi.mocked(cacheGet).mockImplementation(async k => k===key ? {version:2,stamp,contentType:'image/svg+xml',base64:'PHN2Zz4='}:null);
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(Buffer.from(raw,'base64'),{headers:{'Content-Type':'image/png'}}));
    expect(await run(fetcher)).toBe('data:image/png;base64,'+raw);
    expect(cacheDelete).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce();
    expect(cacheSet).toHaveBeenCalledWith(key,{version:2,stamp,contentType:'image/png',base64:raw},expect.anything(),604800);
  });
  it('active or malformed provider images never enter the seven-day cache', async () => {
    vi.mocked(cacheGet).mockResolvedValue(null);
    for (const [mime,body] of [['image/svg+xml','<svg/>'],['image/png','not a PNG']]) {
      await expect(run(async()=>new Response(body,{headers:{'Content-Type':mime}}))).rejects.toThrow();
    }
    expect(cacheSet).not.toHaveBeenCalled();
  });
  it('missing credentials never consume a cached code or call the provider', async () => {
    const fetcher=vi.fn<typeof fetch>();
    expect(await run(fetcher,false)).toBeNull();
    expect(cacheGet).not.toHaveBeenCalled(); expect(redis.get).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
});
