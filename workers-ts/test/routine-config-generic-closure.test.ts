import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, type Container } from '@/lib/di';
import { notificationTemplate, orderNotificationDelivery, systemConfig, systemNotification, wechatUser } from '@/models/schema';
import { adminConfigGet, adminConfigList, adminConfigSave } from '@/controllers/api/v1/AdminCrudController';
import { readiness } from '@/controllers/api/v1/AdminNotificationController';
import { AdminConfigBatchService, normalizeAdminConfigBatch, readAdminConfigBatch } from '@/services/system/AdminConfigBatchService';
import { PublicBootstrapCompatibilityService } from '@/services/system/PublicBootstrapCompatibilityService';
import { SystemConfigService } from '@/services/system/SystemConfigService';
import { financeMemoryPostgres } from './helpers/financePostgres';

// Independent exact contract list: production additions cannot silently widen
// this proof. Authentication/permissions are outside this controller fixture;
// the real handlers, configuration DAO, SQL and envelopes execute unchanged.
const AUTHOR_KEYS = ['routine_appId', 'routine_appsecret', 'routine_name', 'routine_contact_type', 'store_user_avatar'] as const;
const PAIR = ['routine_appId', 'routine_appsecret'] as const;
const APP_ID = 'sql-mini-app-only', SECRET = 'sql-mini-secret-only';

describe('Mini author domain closes generic writers and credential KV reads', () => {
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>, container: Container, env: Env;
  let cache: Map<string, string>;
  let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  beforeAll(async () => {
    f = await financeMemoryPostgres([systemConfig, systemNotification, notificationTemplate, wechatUser, orderNotificationDelivery], { namespace: 'public' });
  }, 30_000);
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => {
    await f.reset();
    await f.db.insert(systemConfig).values([
      { id: 1, menuName: 'routine_appId', value: JSON.stringify(APP_ID), sort: 5 },
      { id: 2, menuName: 'routine_appsecret', value: JSON.stringify(SECRET), sort: 5 },
      { id: 3, menuName: 'routine_name', value: 'public mini name' },
      { id: 4, menuName: 'routine_contact_type', value: '2' },
      { id: 5, menuName: 'store_user_avatar', value: '1' },
      { id: 6, menuName: 'site_name', value: 'unchanged ordinary setting' },
      { id: 7, menuName: 'routine_appsecret', value: 'old-shadow-secret', sort: -1, status: 1 },
      { id: 8, menuName: 'routine_appsecret', value: 'store-secret', isStore: 1, sort: 99 },
    ]);
    container = createContainerFromDb(f.db);
    cache = new Map([['cfg_routine_appId', 'poisoned-mini-app'], ['cfg_routine_appsecret', 'poisoned-mini-secret']]);
    env = { APP_KEY: '', CONFIG_KV: {
      get: vi.fn(async (key: string) => cache.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { cache.set(key, value); }),
      delete: vi.fn(async (key: string) => { cache.delete(key); }),
    } } as unknown as Env;
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Generic config closure forbids provider I/O'));
  });
  afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

  const rows = () => f.db.select().from(systemConfig).orderBy(systemConfig.id);
  const noCacheCalls = () => {
    expect(env.CONFIG_KV.get).not.toHaveBeenCalled();
    expect(env.CONFIG_KV.put).not.toHaveBeenCalled();
    expect(env.CONFIG_KV.delete).not.toHaveBeenCalled();
  };
  const noPairCacheCalls = () => {
    for (const operation of [env.CONFIG_KV.get, env.CONFIG_KV.put, env.CONFIG_KV.delete])
      for (const [key] of vi.mocked(operation).mock.calls) expect(PAIR.map(name => `cfg_${name}`)).not.toContain(key);
  };
  const app = () => {
    const result = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    result.use('*', async (c, next) => { c.set('container', container); await next(); });
    result.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    result.get('/api/admin/config/list', adminConfigList);
    result.get('/api/admin/config/:menuName', adminConfigGet);
    result.get('/adminapi/setting/config/:menuName', adminConfigGet);
    result.post('/api/admin/config/save', adminConfigSave);
    result.get('/api/admin/notification/readiness', readiness);
    return result;
  };

  it('prevalidates all five exact keys anywhere in a mixed batch before SQL/KV', async () => {
    const before = await rows(), transaction = vi.spyOn(f.db, 'transaction');
    const service = new AdminConfigBatchService(container, env);
    for (const key of AUTHOR_KEYS) {
      for (const body of [{ [key]: 'changed' }, { site_name: 'changed', [key]: 'changed', ordinary_new: 'new' }, { [key]: 'changed', site_name: 'changed' }]) {
        expect(() => normalizeAdminConfigBatch(body)).toThrow('/wechat/routine');
        await expect(service.save(body)).rejects.toThrow('/wechat/routine');
      }
    }
    expect(transaction).not.toHaveBeenCalled(); noCacheCalls();
    expect(await rows()).toEqual(before);
  });

  it('rejects a JSON-escaped credential key and keeps the dedicated domain exact', async () => {
    const input = await readAdminConfigBatch(new Request('https://local/config/save', {
      method: 'POST', body: '{"site_name":"changed","routine_app\\u0073ecret":"changed"}',
    }));
    expect(() => normalizeAdminConfigBatch(input)).toThrow('/wechat/routine');
    expect(normalizeAdminConfigBatch({ routine_appId_backup: '1', routine_auth_type: '1',
      store_user_mobile: '0', store_user_agreement: '1', order_shipping_open: '0', routine_home_banner: '[]' })).toHaveLength(6);
    noCacheCalls();
  });

  it('hides every author row and shadow from the real generic list envelope', async () => {
    const response = await app().request('/api/admin/config/list', {}, env);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({ status: 200, msg: 'ok', data: [expect.objectContaining({ menuName: 'site_name', value: 'unchanged ordinary setting' })] });
    noCacheCalls();
  });

  it('rejects all five generic get keys on both controller aliases before DAO or KV', async () => {
    const getValue = vi.spyOn(container.systemConfigDao, 'getValue'), select = vi.spyOn(f.db, 'select');
    for (const prefix of ['/api/admin/config/', '/adminapi/setting/config/']) for (const key of AUTHOR_KEYS) {
      const response = await app().request(`${prefix}${key}`, {}, env);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(await response.json()).toEqual({ status: 400, msg: '小程序配置仅可通过专用接口读取，密钥不回显', data: null });
    }
    expect(getValue).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled(); noCacheCalls();
  });

  it('rejects actual controller mixed saves atomically while ordinary configuration remains usable', async () => {
    const before = await rows(), transaction = vi.spyOn(f.db, 'transaction');
    for (const key of AUTHOR_KEYS) {
      const response = await app().request('/api/admin/config/save', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ site_name: 'changed', [key]: 'changed' }) }, env);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(await response.json()).toEqual({ status: 400, msg: `配置${key}只能通过/wechat/routine专用接口保存`, data: null });
    }
    expect(transaction).not.toHaveBeenCalled(); noCacheCalls(); expect(await rows()).toEqual(before);
    const response = await app().request('/api/admin/config/save', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{"site_name":"ordinary committed"}' }, env);
    expect(await response.json()).toMatchObject({ status: 200 });
    const after = await rows();
    for (const row of before) expect(after.find(next => next.id === row.id)).toEqual(row.menuName === 'site_name' ? { ...row, value: 'ordinary committed' } : row);
    expect(vi.mocked(env.CONFIG_KV.delete).mock.calls).toEqual([['cfg_site_name']]);
    const get = await app().request('/api/admin/config/site_name', {}, env);
    expect(await get.json()).toEqual({ status: 200, msg: 'ok', data: { menuName: 'site_name', value: 'ordinary committed' } });
    noPairCacheCalls();
  });

  it('rejects the pair before any DAO/SQL/KV work even with a poisoned hit or an ordinary key first', async () => {
    const service = new SystemConfigService(container, env);
    const getValue = vi.spyOn(container.systemConfigDao, 'getValue'), getValues = vi.spyOn(container.systemConfigDao, 'getValues');
    const select = vi.spyOn(f.db, 'select'), transaction = vi.spyOn(f.db, 'transaction');
    for (const key of PAIR) {
      await expect(service.get(key)).rejects.toThrow('小程序凭据');
      await expect(service.getMany(['site_name', key, 'routine_contact_type'])).rejects.toThrow('小程序凭据');
    }
    expect(getValue).not.toHaveBeenCalled(); expect(getValues).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled(); noCacheCalls();
  });

  it('retains public contact/avatar/name reads and the imported contact=2 compatibility contract', async () => {
    const service = new SystemConfigService(container, env);
    expect(await service.getMany(['routine_name', 'routine_contact_type', 'store_user_avatar'])).toEqual({
      routine_name: 'public mini name', routine_contact_type: '2', store_user_avatar: '1',
    });
    expect(await service.get('store_user_avatar')).toBe('1');
    expect(await new PublicBootstrapCompatibilityService(container, env).customerType()).toMatchObject({ routine_contact_type: 2 });
    noPairCacheCalls();
  });

  it('readiness returns only fresh SQL pair presence without APP_KEY and preserves other channel/count projections', async () => {
    await f.db.insert(systemConfig).values([
      { id: 20, menuName: 'order_shipping_open', value: '0', sort: -1 },
      { id: 21, menuName: 'order_shipping_open', value: '1', sort: 5 },
      { id: 22, menuName: 'site_url', value: 'https://shop.example.invalid', sort: 5 },
      { id: 23, menuName: 'site_url', value: '', sort: -1 },
      { id: 24, menuName: 'site_url', value: 'store-site', isStore: 1 },
      { id: 25, menuName: 'wechat_appid', value: 'official-id' },
      { id: 26, menuName: 'wechat_appsecret', value: 'official-secret' },
      { id: 27, menuName: 'pay_weixin_mchid', value: 'merchant-id' },
    ]);
    await f.db.insert(systemNotification).values([{ mark: 'order_postage_success' }, { mark: 'unrelated' }]);
    await f.db.insert(notificationTemplate).values([{ mark: 'order_postage_success' }, { mark: '3098' }, { mark: 'unrelated' }]);
    await f.db.insert(wechatUser).values([{ openid: 'one' }, { openid: 'two' }]);
    const statuses = ['PENDING', 'RETRYABLE', 'SENT', 'UNKNOWN', 'DEAD', 'SKIPPED'] as const;
    await f.db.insert(orderNotificationDelivery).values(statuses.map((status, index) => ({
      outboxId: index + 1, eventKey: `readiness-${index}`, orderId: index + 1, userId: 1,
      noticeMark: 'order_postage_success', channel: 'sms' as const, payload: { kind: 'sms' as const, params: {} }, status,
    })));
    Object.assign(env, { ALIYUN_SMS_ACCESS_KEY_ID: 'id', ALIYUN_SMS_ACCESS_KEY_SECRET: 'secret', ALIYUN_SMS_SIGN_NAME: 'sign',
      ALIYUN_SMS_REGION_ID: 'region', ALIYUN_SMS_VERIFICATION_TEMPLATE_CODE: 'template', UPSTASH_REDIS_URL: 'url', UPSTASH_REDIS_TOKEN: 'token' });
    const before = await rows();
    const response = await app().request('/api/admin/notification/readiness', {}, env), text = await response.text();
    const body = JSON.parse(text);
    expect(body.status).toBe(200);
    expect(body.data).toEqual({
      sms: { accessKeyIdConfigured: true, accessKeySecretConfigured: true, signNameConfigured: true,
        regionConfigured: true, verificationTemplateConfigured: true, verificationCacheConfigured: true },
      wechat: { officialAppIdConfigured: true, officialSecretConfigured: true, routineAppIdConfigured: true,
        routineSecretConfigured: true, merchantIdConfigured: true, identityRows: 2 },
      shipping: { enabled: true, configRows: 2 }, site: { urlConfigured: true, urlRows: 2 },
      catalog: { notificationRows: 1, templateRows: 2 }, deliveries: { pending: 2, sent: 1, unknown: 1, dead: 1, skipped: 1 },
      secretPolicy: 'Worker secrets are never returned or written through this API',
    });
    for (const value of [APP_ID, SECRET, 'old-shadow-secret', 'store-secret', 'poisoned-mini-app', 'poisoned-mini-secret', 'official-secret']) expect(text).not.toContain(value);
    expect(await rows()).toEqual(before); noPairCacheCalls();
  });

  it('readiness observes a malformed SQL winner and subsequent rotation instead of stale KV or a valid shadow', async () => {
    await f.db.update(systemConfig).set({ value: '{}' }).where(eq(systemConfig.id, 2));
    const first = await app().request('/api/admin/notification/readiness', {}, env);
    expect(await first.json()).toMatchObject({ data: { wechat: { routineAppIdConfigured: true, routineSecretConfigured: false } } });
    await f.db.update(systemConfig).set({ value: 'rotated-secret' }).where(eq(systemConfig.id, 2));
    await f.db.update(systemConfig).set({ value: '"  "' }).where(eq(systemConfig.id, 1));
    const second = await app().request('/api/admin/notification/readiness', {}, env);
    expect(await second.json()).toMatchObject({ data: { wechat: { routineAppIdConfigured: false, routineSecretConfigured: true } } });
    noPairCacheCalls();
  });

  it('readiness propagates a complete-source capacity fault without a cache fallback or credential echo', async () => {
    await f.db.insert(systemConfig).values(Array.from({ length: 62 }, (_, index) => ({
      id: index + 50, menuName: 'routine_appsecret', value: 'shadow', sort: -5,
    })));
    const before = await rows(), response = await app().request('/api/admin/notification/readiness', {}, env);
    expect(await response.json()).toEqual({ status: 400, msg: '小程序配置超过完整读取容量，请维护后重试', data: null });
    expect(await rows()).toEqual(before); noPairCacheCalls();
  });
});
