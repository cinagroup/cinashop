import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Env } from '../src/env';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { systemConfig, qrcode, wechatQrcode } from '../src/models/schema';
import { financeMemoryPostgres } from './helpers/financePostgres';
import { readOfficialAccountCallbackConfig, readOfficialAccountCredentials, readOfficialAccountCredentialsInTx, officialCredentialCacheKey } from '../src/services/wechat/OfficialAccountRuntimeConfig';
import { OfficialAccountQrcodeService } from '../src/services/wechat/OfficialAccountQrcodeService';
import { WechatAuthService } from '../src/services/wechat/WechatAuthService';
import { WechatNotificationProvider } from '../src/services/wechat/WechatNotificationProvider';
import { WECHAT_BASE_CALLBACK_AUTHORITY_KEY } from '../../view/common/wechatBase';

const cache = vi.hoisted(() => ({ values: new Map<string, unknown>(), gets: [] as string[], puts: [] as string[], deletes: [] as string[] }));
vi.mock('../src/utils/cache', async original => ({
  ...await original<typeof import('../src/utils/cache')>(),
  cacheGet: vi.fn(async (key: string) => { cache.gets.push(key); return cache.values.get(key) ?? null; }),
  cacheSet: vi.fn(async (key: string, value: unknown) => { cache.puts.push(key); cache.values.set(key, value); return true; }),
  cacheDelete: vi.fn(async (key: string) => { cache.deletes.push(key); cache.values.delete(key); return true; }),
}));
const aesKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString('base64').slice(0, -1);

describe('official-account fresh runtime configuration and actual consumers', () => {
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>;
  let env: Env;
  let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  beforeAll(async () => {
    f = await financeMemoryPostgres([systemConfig, qrcode, wechatQrcode]);
    await f.exec('CREATE UNIQUE INDEX qrcode_third_type_third_id_uq ON qrcode (third_type,third_id)');
  });
  afterAll(async () => { await f.close(); });
  beforeEach(async () => {
    cache.values.clear(); cache.gets.length = 0; cache.puts.length = 0; cache.deletes.length = 0;
    env = { APP_KEY: 'owned-official-runtime-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
      CONFIG_KV: { get: vi.fn(async () => { throw Error('Official credentials must not consult cfg KV'); }), put: vi.fn(), delete: vi.fn() },
    } as unknown as Env;
    await f.db.delete(qrcode); await f.db.delete(wechatQrcode); await f.db.delete(systemConfig);
    await f.db.insert(systemConfig).values([
      { id: 1, menuName: 'wechat_appid', value: '"legacy-app"', status: 0 },
      { id: 2, menuName: 'wechat_appsecret', value: '"legacy-secret"', status: 0 },
    ]);
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Uncontrolled official provider forbidden'));
  });
  afterEach(() => { vi.restoreAllMocks(); });
  const container = () => createContainerFromDb(f.db);
  const snapshot = () => f.db.select().from(systemConfig).orderBy(systemConfig.id);
  async function callback(values: { mode?: string; authority?: string; token?: string; aes?: string } = {}) {
    await f.db.insert(systemConfig).values([
      { id: 3, menuName: 'wechat_encode', value: values.mode ?? '0' },
      { id: 4, menuName: WECHAT_BASE_CALLBACK_AUTHORITY_KEY, value: values.authority ?? 'database' },
      { id: 5, menuName: 'wechat_token', value: values.token ?? 'FixtureToken123' },
      { id: 6, menuName: 'wechat_encodingaeskey', value: values.aes ?? aesKey },
    ]);
  }

  it('reads a complete legacy credential pair from fresh SQL without KV or database mutation', async () => {
    const before = await snapshot(), credentials = await readOfficialAccountCredentials(container(), env);
    expect(credentials).toMatchObject({ appId: 'legacy-app', secret: 'legacy-secret' });
    expect(credentials.stamp).toMatch(/^[a-f0-9]{64}$/); expect(await snapshot()).toEqual(before);
    expect(env.CONFIG_KV.get).not.toHaveBeenCalled(); expect(env.CONFIG_KV.put).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it('uses platform sort/id winners but stamps every shadow row and its metadata', async () => {
    await f.db.insert(systemConfig).values([
      { id: 10, menuName: 'wechat_appsecret', value: 'store-secret', sort: 999, isStore: 1 },
      { id: 11, menuName: 'wechat_appsecret', value: 'shadow-secret', sort: -1 },
      { id: 12, menuName: 'wechat_appsecret', value: 'winner-secret', sort: 0, status: 0 },
    ]);
    const first = await readOfficialAccountCredentials(container(), env);
    expect(first.secret).toBe('winner-secret');
    await f.db.update(systemConfig).set({ desc: 'changed shadow only' }).where(eq(systemConfig.id, 11));
    const second = await readOfficialAccountCredentials(container(), env);
    expect(second.secret).toBe(first.secret); expect(second.stamp).not.toBe(first.stamp);
    await f.db.update(systemConfig).set({ value: 'store-rotation' }).where(eq(systemConfig.id, 10));
    expect((await readOfficialAccountCredentials(container(), env)).stamp).toBe(second.stamp);
  });
  it('allows exactly 64 source rows and rejects overflow instead of truncating a secret winner', async () => {
    await f.db.insert(systemConfig).values(Array.from({ length: 62 }, (_, i) => ({ id: 10 + i, menuName: 'wechat_appsecret', value: 'shadow', sort: -1 })));
    await expect(readOfficialAccountCredentials(container(), env)).resolves.toHaveProperty('secret', 'legacy-secret');
    await f.db.insert(systemConfig).values({ id: 100, menuName: 'wechat_appsecret', value: 'late-shadow', sort: -1 });
    await expect(readOfficialAccountCredentials(container(), env)).rejects.toThrow('完整读取容量');
  });
  it('isolates all official token/ticket cache identities on pair and shadow rotation without exposing secrets', async () => {
    const first = await readOfficialAccountCredentials(container(), env);
    await f.db.update(systemConfig).set({ value: 'rotated-private-secret' }).where(eq(systemConfig.id, 2));
    const next = await readOfficialAccountCredentials(container(), env);
    for (const purpose of ['access-token', 'jsapi-ticket'] as const) {
      expect(officialCredentialCacheKey(next, purpose)).not.toBe(officialCredentialCacheKey(first, purpose));
      expect(officialCredentialCacheKey(next, purpose)).not.toMatch(/private|secret|legacy-app/);
    }
    expect(officialCredentialCacheKey(next, 'access-token')).not.toBe(officialCredentialCacheKey(next, 'jsapi-ticket'));
  });
  it('fails closed without APP_KEY and never derives a public digest of low-entropy secrets', async () => {
    await expect(readOfficialAccountCredentials(container(), { APP_KEY: '' })).rejects.toThrow('签名未配置');
    expect(cache.puts).toEqual([]);
  });
  it.each(['deployment', ' database', 'database ', '"database"', 'DATABASE'])('requires exact raw database authority rather than %j', async authority => {
    await callback({ authority });
    await expect(readOfficialAccountCallbackConfig(container(), env)).rejects.toThrow('authority_disabled');
  });
  it('does not opt in when the authority row is missing', async () => {
    await expect(readOfficialAccountCallbackConfig(container(), env)).rejects.toThrow('authority_disabled');
  });
  it('keeps a complete deployment binding authoritative even with explicit database plaintext staging', async () => {
    await callback({ mode: '0', token: 'DifferentDatabaseToken' });
    env.WECHAT_OFFICIAL_CALLBACK_TOKEN = 'legacy token with spaces'; env.WECHAT_OFFICIAL_CALLBACK_AES_KEY = aesKey;
    expect(await readOfficialAccountCallbackConfig(container(), env)).toEqual({ appId: 'legacy-app', token: 'legacy token with spaces', aesKey, mode: 2, authority: 'deployment' });
  });
  it.each([
    { token: 'DeployedToken', aes: '' }, { token: '', aes: aesKey }, { token: '   ', aes: '' }, { token: 'DeployedToken', aes: '  ' },
  ])('never falls back from a partial or invalid deployment binding: %j', async deployed => {
    await callback({ mode: '0' }); env.WECHAT_OFFICIAL_CALLBACK_TOKEN = deployed.token; env.WECHAT_OFFICIAL_CALLBACK_AES_KEY = deployed.aes;
    await expect(readOfficialAccountCallbackConfig(container(), env)).rejects.toThrow(/wechat_callback_(?:token|aes_key)_invalid/);
  });
  it('permits database plaintext mode with no AES key while keeping a valid token mandatory', async () => {
    await callback({ mode: '0', aes: '' });
    expect(await readOfficialAccountCallbackConfig(container(), env)).toMatchObject({ mode: 0, aesKey: '', authority: 'database' });
    await f.db.update(systemConfig).set({ value: 'bad token' }).where(eq(systemConfig.menuName, 'wechat_token'));
    await expect(readOfficialAccountCallbackConfig(container(), env)).rejects.toThrow('token_invalid');
  });
  it.each(['1', '2'])('requires a valid AES key in database mode %s', async mode => {
    await callback({ mode, aes: '' }); await expect(readOfficialAccountCallbackConfig(container(), env)).rejects.toThrow('aes_key_invalid');
    await f.db.update(systemConfig).set({ value: aesKey }).where(eq(systemConfig.menuName, 'wechat_encodingaeskey'));
    expect((await readOfficialAccountCallbackConfig(container(), env)).mode).toBe(Number(mode));
  });
  it('rejects an unknown stored mode instead of silently selecting plaintext', async () => {
    await callback({ mode: '7' }); await expect(readOfficialAccountCallbackConfig(container(), env)).rejects.toThrow('mode_invalid');
  });

  it('actual QR transport ignores legacy cache keys and uses the fresh complete pair', async () => {
    cache.values.set('official_access_token:legacy-app', 'stale-token'); cache.values.set('wechat_access_token', 'stale-token');
    const requests: URL[] = [];
    const fetcher: typeof fetch = async input => { const url = new URL(String(input)); requests.push(url); return Response.json(url.pathname.endsWith('/token')
      ? { access_token: 'fresh-token', expires_in: 7200 } : { ticket: 'fresh-ticket', expire_seconds: 2592000 }); };
    const service = new OfficialAccountQrcodeService(container(), env, fetcher);
    await expect(service.requestTemporaryProduct('p:1:1:1800000000:' + 'a'.repeat(24))).resolves.toContain('fresh-ticket');
    expect(requests[0].searchParams.get('appid')).toBe('legacy-app'); expect(requests[0].searchParams.get('secret')).toBe('legacy-secret');
    expect(requests[1].searchParams.get('access_token')).toBe('fresh-token');
    expect(cache.gets).not.toContain('official_access_token:legacy-app'); expect(cache.gets).not.toContain('wechat_access_token');
    expect(network).not.toHaveBeenCalled();
  });
  it('actual QR retry refuses rotation rather than combining a new account with an old request', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async input => { calls++; if (new URL(String(input)).pathname.endsWith('/token')) return Response.json({ access_token: 'first', expires_in: 7200 });
      await f.db.update(systemConfig).set({ value: 'new-secret' }).where(eq(systemConfig.id, 2)); return Response.json({ errcode: 40014 }); };
    await expect(new OfficialAccountQrcodeService(container(), env, fetcher).requestTemporaryProduct('p:1:1:1800000000:' + 'b'.repeat(24))).rejects.toThrow('账户配置已变化');
    expect(calls).toBe(2); expect(cache.deletes).toEqual([]);
  });
  it('actual JS-SDK appId, token and ticket use one snapshot even if configuration rotates during provider I/O', async () => {
    cache.values.set('jsapi_ticket', 'stale-ticket'); cache.values.set('wechat_access_token', 'stale-token');
    const requests: URL[] = [];
    network.mockImplementation(async input => {
      const url = new URL(String(input)); requests.push(url);
      if (url.pathname.endsWith('/token')) { await f.db.update(systemConfig).set({ value: 'new-app' }).where(eq(systemConfig.id, 1)); return Response.json({ access_token: 'old-pair-token', expires_in: 7200 }); }
      expect(url.searchParams.get('access_token')).toBe('old-pair-token'); return Response.json({ ticket: 'old-pair-ticket', expires_in: 7200 });
    });
    const auth = new WechatAuthService(container(), env), result = await auth.jsSdkConfig('https://shop.example.test/path');
    expect(result.appId).toBe('legacy-app'); expect(requests).toHaveLength(2);
    const next = await readOfficialAccountCredentials(container(), env);
    expect(cache.values.has(officialCredentialCacheKey(next, 'jsapi-ticket'))).toBe(false);
    expect(cache.gets).not.toContain('jsapi_ticket'); expect(cache.gets).not.toContain('wechat_access_token');
  });
  it('actual notification transport shares only the matching complete-pair token namespace', async () => {
    cache.values.set('wechat_access_token', 'stale-token');
    const current = await readOfficialAccountCredentials(container(), env), calls: URL[] = [];
    cache.values.set(officialCredentialCacheKey(current, 'access-token'), 'bound-token');
    const fetcher: typeof fetch = async input => { const url = new URL(String(input)); calls.push(url); expect(url.searchParams.get('access_token')).toBe('bound-token'); return Response.json({ errcode: 0, msgid: 9 }); };
    await expect(new WechatNotificationProvider(container(), env, fetcher).sendOfficial('openid', 'template', { kind: 'wechat_official', url: 'https://shop.example.test', data: { first: 'hello' } })).resolves.toMatchObject({ providerReference: '9' });
    expect(calls).toHaveLength(1); expect(calls[0].pathname).toBe('/cgi-bin/message/template/send'); expect(cache.gets).not.toContain('wechat_access_token');
  });
  it('actual notification invalid-token retry fences a credential rotation with no second POST', async () => {
    let posts = 0, tokens = 0;
    const fetcher: typeof fetch = async input => { const url = new URL(String(input)); if (url.pathname.endsWith('/token')) { tokens++; return Response.json({ access_token: 'old-token', expires_in: 7200 }); }
      posts++; await f.db.update(systemConfig).set({ value: 'rotated-secret' }).where(eq(systemConfig.id, 2)); return Response.json({ errcode: 40014 }); };
    await expect(new WechatNotificationProvider(container(), env, fetcher).sendOfficial('openid', 'template', { kind: 'wechat_official', url: '', data: {} })).rejects.toThrow('账户配置已变化');
    expect({ posts, tokens }).toEqual({ posts: 1, tokens: 1 });
  });
  it('routine notification uses its fresh SQL pair and does not borrow official credentials or stale KV', async () => {
    await f.db.insert(systemConfig).values([{ id: 10, menuName: 'routine_appId', value: '"routine-app"' },
      { id: 11, menuName: 'routine_appsecret', value: '"routine-secret"' }]);
    cache.values.set('routine_access_token:routine-app', 'legacy-token');
    const calls: URL[] = [], fetcher: typeof fetch = async input => { const url = new URL(String(input)); calls.push(url);
      return Response.json(url.pathname.endsWith('/token') ? { access_token: 'routine-token', expires_in: 7200 } : { errcode: 0 }); };
    await new WechatNotificationProvider(container(), env, fetcher).sendRoutine('openid', 'template', { kind: 'wechat_routine', routineAppId: 'routine-app', url: '', data: {} });
    expect(calls).toHaveLength(2); expect(calls[0].searchParams.get('appid')).toBe('routine-app'); expect(calls[0].searchParams.get('secret')).toBe('routine-secret');
    expect(calls[1].searchParams.get('access_token')).toBe('routine-token'); expect(env.CONFIG_KV.get).not.toHaveBeenCalled();
    expect(cache.gets).not.toContain('routine_access_token:routine-app');
  });
  it('caller-owned transaction reads the exact same full credential stamp without nesting a transaction', async () => {
    const expected = await readOfficialAccountCredentials(container(), env), transactions = vi.spyOn(f.db, 'transaction');
    expect(await withTx(container(), tx => readOfficialAccountCredentialsInTx(tx, env))).toEqual(expected);
    expect(transactions).toHaveBeenCalledTimes(1);
  });
  it('a permanent QR response from the former account cannot publish its ticket or channel image', async () => {
    await f.db.insert(wechatQrcode).values({ id: 5, image: '/old-channel.png', isDel: 0 });
    const calls: URL[] = [], fetcher: typeof fetch = async input => {
      const url = new URL(String(input)); calls.push(url); if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'old-account-token', expires_in: 7200 });
      await f.db.update(systemConfig).set({ value: 'new-account' }).where(eq(systemConfig.id, 1));
      return Response.json({ ticket: 'old-account-ticket', url: 'https://weixin.qq.com/q/old-account' });
    };
    await expect(new OfficialAccountQrcodeService(container(), env, fetcher).processProvision({ action: 'provisionOfficialAccountQrcode', thirdType: 'wechatqrcode', thirdId: 5 })).rejects.toThrow('旧二维码结果不能保存');
    expect(calls).toHaveLength(2); expect(await f.db.select().from(qrcode)).toMatchObject([{ ticket: '', url: '', status: 0 }]);
    expect((await f.db.select().from(wechatQrcode))[0].image).toBe('/old-channel.png');
  });
  it('a changed credential shadow row also rejects the late permanent response despite unchanged winners', async () => {
    await f.db.insert(systemConfig).values({ id: 20, menuName: 'wechat_appsecret', value: 'shadow', sort: -1 });
    const fetcher: typeof fetch = async input => {
      if (new URL(String(input)).pathname.endsWith('/token')) return Response.json({ access_token: 'bound-token', expires_in: 7200 });
      await f.db.update(systemConfig).set({ info: 'changed shadow identity' }).where(eq(systemConfig.id, 20));
      return Response.json({ ticket: 'old-shadow-ticket', url: 'https://weixin.qq.com/q/old-shadow' });
    };
    await expect(new OfficialAccountQrcodeService(container(), env, fetcher).processProvision({ action: 'provisionOfficialAccountQrcode', thirdType: 'reply', thirdId: 6 })).rejects.toThrow('旧二维码结果不能保存');
    expect((await f.db.select().from(qrcode))[0]).toMatchObject({ ticket: '', url: '', status: 0 });
  });
  it('permanent publication and ready reuse synchronize the real channel in the same local transaction', async () => {
    await f.db.insert(wechatQrcode).values({ id: 5, image: '/old-channel.png', isDel: 0 }); let calls = 0;
    const fetcher: typeof fetch = async input => { calls++; return Response.json(new URL(String(input)).pathname.endsWith('/token') ? { access_token: 'bound-token', expires_in: 7200 } : { ticket: 'owned-permanent-ticket', url: 'https://weixin.qq.com/q/owned' }); };
    const service = new OfficialAccountQrcodeService(container(), env, fetcher), message = { action: 'provisionOfficialAccountQrcode' as const, thirdType: 'wechatqrcode' as const, thirdId: 5 };
    expect(await service.processProvision(message)).toEqual({ status: 'ready', reused: false });
    const [row] = await f.db.select().from(qrcode); expect(row.ticket).toBe('owned-permanent-ticket'); expect((await f.db.select().from(wechatQrcode))[0].image).toBe(row.url);
    await f.db.update(wechatQrcode).set({ image: '/stale-channel.png' }).where(eq(wechatQrcode.id, 5));
    expect(await service.requestPermanent('wechatqrcode', 5)).toEqual({ status: 'ready', queued: false, url: row.url });
    expect((await f.db.select().from(wechatQrcode))[0].image).toBe(row.url);
    expect(await service.processProvision(message)).toEqual({ status: 'ready', reused: true }); expect(calls).toBe(2);
  });
  it('a real channel synchronization failure rolls back the ticket publication instead of leaving half a result', async () => {
    await f.db.insert(wechatQrcode).values({ id: 5, image: '/old-channel.png', isDel: 0 });
    await f.exec("CREATE FUNCTION owned_qr_sync_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned synchronization fault'; END $$; CREATE TRIGGER owned_qr_sync_fault BEFORE UPDATE ON wechat_qrcode FOR EACH ROW EXECUTE FUNCTION owned_qr_sync_fault()");
    try {
      const fetcher: typeof fetch = async input => Response.json(new URL(String(input)).pathname.endsWith('/token') ? { access_token: 'bound-token', expires_in: 7200 } : { ticket: 'must-rollback', url: 'https://weixin.qq.com/q/rollback' });
      await expect(new OfficialAccountQrcodeService(container(), env, fetcher).processProvision({ action: 'provisionOfficialAccountQrcode', thirdType: 'wechatqrcode', thirdId: 5 })).rejects.toMatchObject({ cause: { message: 'owned synchronization fault' } });
      expect((await f.db.select().from(qrcode))[0]).toMatchObject({ ticket: '', url: '', status: 0 }); expect((await f.db.select().from(wechatQrcode))[0].image).toBe('/old-channel.png');
    } finally { await f.exec('DROP TRIGGER owned_qr_sync_fault ON wechat_qrcode; DROP FUNCTION owned_qr_sync_fault()'); }
  });
});
