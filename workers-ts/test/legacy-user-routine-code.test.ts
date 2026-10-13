import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Env } from '@/env';
import { createApp } from '@/app';
import { createContainerFromDb, type Container } from '@/lib/di';
import { legacyCache, systemConfig, user } from '@/models/schema';
import { LegacyShareCodeService, parseLegacyShareInput } from '@/services/other/LegacyShareCodeService';
import { createToken, md5 } from '@/utils/jwt';
import { ApiErrorCode } from '@/utils/errors';
import { financePostgres } from './helpers/financePostgres';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({
  ...await original<typeof import('@/lib/di')>(),
  createContainer: () => {
    if (!wiring.container) throw Error('Owned routine-code SQL fixture unavailable');
    return wiring.container;
  },
}));

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6JqkAAAAASUVORK5CYII='), char => char.charCodeAt(0));
type Envelope = { status: number; msg?: string; data: Record<string, unknown> | null };
type ProviderRequest = { host: string; path: string; body?: Record<string, unknown> };
const absolute = (path: string) => new URL(path, 'https://api.example.com').href;
const tokenFromImage = (path: string) => new URL(path, 'https://api.example.com').pathname.split('/')[5]!;

describe('registered user routine-code mini-required alias with genuine SQL and UserJWT', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, env: Env, app: ReturnType<typeof createApp>;
  let provider: ReturnType<typeof vi.spyOn>, decision: unknown, providerMode: 'normal' | 'invalid-token' | 'bad-raster';
  let duringMini: (() => Promise<void>) | undefined;
  const config = new Map<string, string>(), requests: ProviderRequest[] = [], quotas: string[] = [];

  beforeAll(async () => {
    f = await financePostgres([user, systemConfig, legacyCache], { namespace: 'public' });
  }, 30000);
  beforeEach(async () => {
    await f.reset(); config.clear(); requests.length = 0; quotas.length = 0;
    providerMode = 'normal'; duringMini = undefined;
    decision = { allowed: true, resetAt: Date.now() + 60000 };
    await f.db.insert(user).values([{ uid: 11, status: 1, nickname: '本人推广账户' }, { uid: 12, status: 1, nickname: '另一账户' }]);
    await f.db.insert(systemConfig).values([
      { menuName: 'station_open', value: '1' }, { menuName: 'site_name', value: '"真实推广商店"' },
      { menuName: 'share_qrcode', value: '1' }, { menuName: 'spread_share_forever', value: '1' },
      { menuName: 'routine_appId', value: '"owned-routine-mini"' },
      { menuName: 'routine_appsecret', value: '"owned-routine-fixture-secret"' },
    ]);
    env = {
      APP_KEY: 'owned-routine-alias-fixture-key', PUBLIC_H5_ORIGIN: 'https://shop.example.test',
      UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
      CONFIG_KV: {
        get: async (key: string) => config.get(key) ?? null,
        put: async (key: string, value: string) => { config.set(key, value); },
        delete: async (key: string) => { config.delete(key); },
      },
      TOKEN_BUCKET: { getByName: (name: string) => ({ consumeRateLimit: async () => { quotas.push(name); return decision; } }) },
    } as unknown as Env;
    wiring.container = createContainerFromDb(f.db); app = createApp();
    provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (target, init) => {
      const url = new URL(target instanceof Request ? target.url : String(target));
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      requests.push({ host: url.hostname, path: url.pathname, ...(body ? { body } : {}) });
      if (url.hostname !== 'api.weixin.qq.com') throw Error('Uncontrolled routine-code fixture host');
      if (url.pathname === '/cgi-bin/token') return Response.json({ access_token: 'owned-routine-provider-token', expires_in: 7200 });
      if (url.pathname === '/wxa/getwxacodeunlimit') {
        await duringMini?.();
        if (providerMode === 'invalid-token') return Response.json({ errcode: 42001, errmsg: 'fixture token rejected' });
        if (providerMode === 'bad-raster') return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'Content-Type': 'image/png' } });
        return new Response(png, { headers: { 'Content-Type': 'image/png' } });
      }
      throw Error('Routine alias must not request official-account tickets or images');
    });
  });
  afterEach(() => { provider.mockRestore(); vi.restoreAllMocks(); vi.useRealTimers(); wiring.container = undefined; });
  afterAll(async () => { await f?.close(); }, 30000);

  const jwt = async (uid = 11, expired = false, digest = md5('')) =>
    (await createToken(uid, 'api', digest, env.APP_KEY, 'cinashop', expired ? Math.floor(Date.now() / 1000) - 8 * 86400 : undefined)).token;
  const actor = () => ({ uid: 11, authVersion: md5(''), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  function noStore(response: Response) { expect(response.headers.get('Cache-Control')).toContain('no-store'); }
  async function request(path = '/api/user/routine_code', credential?: string, userAgent?: string) {
    const response = await app.request(absolute(path), { headers: {
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...(userAgent ? { 'User-Agent': userAgent } : {}),
    } }, env);
    noStore(response);
    return { response, body: await response.json<Envelope>() };
  }
  const cacheRows = () => f.db.select().from(legacyCache);
  async function published() { return (await cacheRows()).filter(row => row.key.startsWith('lshare:')); }
  async function url(credential = '') {
    const result = await request('/api/user/routine_code', credential || await jwt());
    expect(result.body.status).toBe(200); expect(Object.keys(result.body.data!).sort()).toEqual(['url']);
    expect(typeof result.body.data!.url).toBe('string');
    return String(result.body.data!.url);
  }

  it('returns only a signed actual PNG whose opaque released-page scene resolves the authenticated referral', async () => {
    const usersBefore = await f.db.select().from(user), configsBefore = await f.db.select().from(systemConfig);
    const imagePath = await url(), token = tokenFromImage(imagePath);
    expect(imagePath).toMatch(/^https:\/\/api\.example\.com\/api\/share\/code\/image\/[a-f0-9]{24}\/routine\?expires=\d+&signature=[a-f0-9]{64}$/);
    expect(new URL(imagePath).origin).toBe('https://api.example.com');
    expect(new URL(imagePath).origin).not.toBe(env.PUBLIC_H5_ORIGIN);
    const mini = requests.find(row => row.path === '/wxa/getwxacodeunlimit')!;
    expect(mini.body).toMatchObject({ scene: `q=${token}`, page: 'pages/share/landing', check_path: true, env_version: 'release' });
    expect(new TextEncoder().encode(String(mini.body!.scene))).toHaveLength(26);
    const scene = await request(`/api/share/scene/${token}`);
    expect(scene.body.status).toBe(200);
    expect(scene.body.data).toMatchObject({ type: -1, id: 0, spid: 11, path: '/pages/index/index?spid=11', h5_origin: env.PUBLIC_H5_ORIGIN });
    const image = await app.request(absolute(imagePath), {}, env); noStore(image);
    expect(image.status).toBe(200); expect(image.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
    expect(await f.db.select().from(user)).toEqual(usersBefore); expect(await f.db.select().from(systemConfig)).toEqual(configsBefore);
  });

  it('ignores an official-account browser and forever configuration without requesting any official provider', async () => {
    const result = await request('/api/user/routine_code', await jwt(), 'MicroMessenger/8.0');
    expect(result.body.status).toBe(200);
    expect(requests.map(row => row.path)).toEqual(['/cgi-bin/token', '/wxa/getwxacodeunlimit']);
    const documents = (await published()).map(row => JSON.parse(row.result!));
    expect(documents).toHaveLength(1); expect(documents[0].descriptor).toMatchObject({ type: -1, uid: 11, browser: false, official: false, permanent: true });
    expect(documents[0].officialTicket).toBeUndefined();
  });

  it.each(['missing', 'blank'] as const)('rejects %s authoritative SQL AppID before stale KV, provider or cache writes', async state => {
    if (state === 'missing') await f.db.delete(systemConfig).where(eq(systemConfig.menuName, 'routine_appId'));
    else await f.db.update(systemConfig).set({ value: '""' }).where(eq(systemConfig.menuName, 'routine_appId'));
    config.set('cfg_routine_appId', 'stale-foreign-mini');
    const result = await request('/api/user/routine_code', await jwt());
    expect(result.response.status).toBe(503); expect(result.body.status).toBe(503); expect(result.body.data).toBeNull();
    expect(requests).toEqual([]); expect(await cacheRows()).toEqual([]);
  });

  it('preserves the generic -1 contract when mini is disabled instead of changing get_qrcode behavior', async () => {
    await f.db.delete(systemConfig).where(eq(systemConfig.menuName, 'routine_appId'));
    const service = new LegacyShareCodeService(wiring.container!, env);
    const result = await service.code(parseLegacyShareInput('-1', '0', new URLSearchParams()), actor(), false);
    expect(result.routineUrl).toBe(''); expect(result.wechatUrl).toMatch(/^\/api\/share\/code\/image\/[a-f0-9]{24}\/wechat\?/);
    expect(requests).toEqual([]); expect(await published()).toHaveLength(1);
  });

  it('keeps the printed mini target permanent in a separate namespace while generic -1 remains temporary', async () => {
    const first = await url(), permanentToken = tokenFromImage(first);
    const initial = await cacheRows();
    expect(initial.filter(row => row.key.startsWith('lsc:'))).toHaveLength(1);
    expect(initial.filter(row => row.key.startsWith('lshare:'))).toHaveLength(1);
    for (const row of initial) {
      expect(row.expireTime).toBe(0); expect(JSON.parse(row.result!)).toMatchObject({ state: 'ready', expires: 0 });
    }
    const normal = await new LegacyShareCodeService(wiring.container!, env)
      .code(parseLegacyShareInput('-1', '0', new URLSearchParams()), actor(), false);
    expect(tokenFromImage(normal.routineUrl)).not.toBe(permanentToken);
    const rows = await published(), permanent = rows.find(row => row.key === `lshare:${permanentToken}`)!;
    const temporary = rows.find(row => row.key !== permanent.key)!;
    expect(permanent.expireTime).toBe(0);
    expect(JSON.parse(permanent.result!)).toMatchObject({ expires: 0, descriptor: { official: false, permanent: true } });
    expect(temporary.expireTime).toBeGreaterThan(Math.floor(Date.now() / 1000) + 29 * 86400);
    expect(JSON.parse(temporary.result!)).toMatchObject({ descriptor: { official: false, permanent: false } });
    const count = requests.length;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 31 * 86400000);
    const refreshed = await url(await jwt());
    expect(tokenFromImage(refreshed)).toBe(permanentToken); expect(refreshed).not.toBe(first);
    expect(requests).toHaveLength(count);
    expect((await request(first)).body.status).not.toBe(200);
    const image = await app.request(absolute(refreshed), {}, env); noStore(image);
    expect(image.status).toBe(200); expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
  });

  it('keeps the permanent mini referral readable when unrelated official-account settings change', async () => {
    await f.db.insert(systemConfig).values({ menuName: 'wechat_appid', value: '"official-before-rotation"' });
    const credential = await jwt(), first = await url(credential), token = tokenFromImage(first), count = requests.length;
    await f.db.update(systemConfig).set({ value: '"official-after-rotation"' }).where(eq(systemConfig.menuName, 'wechat_appid'));
    for (const name of ['share_qrcode', 'spread_share_forever']) {
      await f.db.update(systemConfig).set({ value: '0' }).where(eq(systemConfig.menuName, name));
    }
    const second = await url(credential); expect(tokenFromImage(second)).toBe(token);
    const scene = await request(`/api/share/scene/${token}`);
    expect(scene.body.status).toBe(200); expect(scene.body.data).toMatchObject({ type: -1, spid: 11, path: '/pages/index/index?spid=11' });
    const image = await app.request(absolute(first), {}, env); noStore(image);
    expect(image.status).toBe(200); expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
    expect(requests).toHaveLength(count);
    expect((await published()).map(row => JSON.parse(row.result!))).toEqual([
      expect.objectContaining({ descriptor: expect.objectContaining({ official: false, permanent: true, officialApp: '' }) }),
    ]);
  });

  it('rejects a wrong cached AppID with 400 before contacting a provider or publishing a ready artifact', async () => {
    config.set('cfg_routine_appId', 'wrong-cached-mini');
    const result = await request('/api/user/routine_code', await jwt());
    expect(result.body.status).toBe(400); expect(result.body.data).toBeNull();
    expect(requests).toEqual([]); expect(await published()).toEqual([]);
  });

  it('keeps missing mini credentials unavailable without publishing a website-only success', async () => {
    await f.db.update(systemConfig).set({ value: '""' }).where(eq(systemConfig.menuName, 'routine_appsecret'));
    const result = await request('/api/user/routine_code', await jwt());
    expect(result.response.status).toBe(503); expect(result.body.status).toBe(503); expect(result.body.data).toBeNull();
    expect(requests).toEqual([]); expect(await published()).toEqual([]);
    expect((await cacheRows()).map(row => JSON.parse(row.result!))).toEqual([expect.objectContaining({ state: 'pending' })]);
  });

  it('reuses the valid artifact while refreshing its image signature and rejects expiry, tampering and owner deactivation', async () => {
    const credential = await jwt(), first = await url(credential), count = requests.length;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30000);
    const second = await url(credential);
    expect(tokenFromImage(second)).toBe(tokenFromImage(first)); expect(second).not.toBe(first); expect(requests).toHaveLength(count);
    const query = new URL(second, 'https://api.example.com'); query.searchParams.set('signature', '0'.repeat(64));
    expect((await request(query.href)).body.status).not.toBe(200);
    clock.mockReturnValue((Number(new URL(first, 'https://api.example.com').searchParams.get('expires')) + 1) * 1000);
    expect((await request(first)).body.status).not.toBe(200);
    clock.mockRestore(); await f.db.update(user).set({ status: 0 }).where(eq(user.uid, 11));
    expect((await request(second)).body.status).not.toBe(200); expect(requests).toHaveLength(count);
  });

  it('rejects missing, malformed, expired and password-revoked genuine JWTs before quota or provider work', async () => {
    const old = await jwt(), expired = await jwt(11, true);
    await f.db.update(user).set({ pwd: 'fixture-rotated-password' }).where(eq(user.uid, 11));
    for (const credential of [undefined, 'not.a.valid.jwt', expired, old]) {
      const result = await request('/api/user/routine_code', credential);
      expect(result.body.status).not.toBe(200); expect(result.body.data).toBeNull();
    }
    expect(quotas).toEqual([]); expect(requests).toEqual([]); expect(await cacheRows()).toEqual([]);
  });

  it('rejects query parameters before quota and ignores no caller-controlled uid or object override', async () => {
    const credential = await jwt();
    for (const suffix of ['?uid=12', '?type=-1', '?x=1&x=2']) {
      const result = await request('/api/user/routine_code' + suffix, credential);
      expect(result.body.status).toBe(400); expect(result.body.data).toBeNull();
    }
    expect(quotas).toEqual([]); expect(requests).toEqual([]); expect(await cacheRows()).toEqual([]);
  });

  it('fails closed on refused or malformed budgets before cache and provider work', async () => {
    const credential = await jwt(); decision = { allowed: false, resetAt: Date.now() + 60000 };
    const refused = await request('/api/user/routine_code', credential);
    expect(refused.response.status).toBe(429); expect(refused.body.status).toBe(429);
    for (const broken of [undefined, { allowed: 'yes', resetAt: Date.now() }, { allowed: true, resetAt: NaN }]) {
      decision = broken; const result = await request('/api/user/routine_code', credential);
      expect(result.response.status).toBe(503); expect(result.body.status).toBe(503);
    }
    expect(requests).toEqual([]); expect(await cacheRows()).toEqual([]);
  });

  it('refreshes a rejected provider token once, then returns 503 without publishing a partial artifact', async () => {
    providerMode = 'invalid-token'; const result = await request('/api/user/routine_code', await jwt());
    expect(result.response.status).toBe(503); expect(result.body.status).toBe(503); expect(result.body.data).toBeNull();
    expect(requests.filter(row => row.path === '/cgi-bin/token')).toHaveLength(2);
    expect(requests.filter(row => row.path === '/wxa/getwxacodeunlimit')).toHaveLength(2);
    expect(await published()).toEqual([]);
  });

  it('rejects declared PNG bytes that are not a real raster instead of publishing or returning a signed URL', async () => {
    providerMode = 'bad-raster'; const result = await request('/api/user/routine_code', await jwt());
    expect(result.body.status).toBe(400); expect(result.body.data).toBeNull(); expect(await published()).toEqual([]);
  });

  it.each(['status', 'password'] as const)('rechecks current owner %s after provider work and never publishes the revoked artifact', async field => {
    const rotatedPassword = 'provider-rotated-password';
    duringMini = async () => { await f.db.update(user).set(field === 'status' ? { status: 0 } : { pwd: rotatedPassword }).where(eq(user.uid, 11)); };
    const result = await request('/api/user/routine_code', await jwt());
    const [current] = await f.db.select({ status: user.status, pwd: user.pwd }).from(user).where(eq(user.uid, 11));
    expect(current).toMatchObject(field === 'status' ? { status: 0 } : { pwd: rotatedPassword });
    expect(result.body.status).toBe(ApiErrorCode.ERR_LOGIN); expect(result.body.data).toBeNull(); expect(await published()).toEqual([]);
    expect(requests.filter(row => row.path === '/wxa/getwxacodeunlimit')).toHaveLength(1);
    expect((await cacheRows()).map(row => JSON.parse(row.result!))).toEqual([expect.objectContaining({ state: 'pending' })]);
  });
});
