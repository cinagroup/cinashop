import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { systemAdmin, systemConfig, systemLog, systemMenus, systemRole, systemStore } from '../src/models/schema';
import { shippingSettingsCanonical, shippingSettingsHash } from '../src/services/admin/AdminShippingSettingsInput';
import { createToken, md5 } from '../src/utils/jwt';
import { shippingSaveInput, shippingSettingsFixture } from './helpers/shippingSettingsFixture';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({ ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Owned shipping HTTP fixture unavailable'); return wiring.container; } }));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('registered shipping-settings routes, actual Admin JWT and runtime LOGINs', () => {
  let f: Awaited<ReturnType<typeof shippingSettingsFixture>>;
  const app = createApp(), tokens = new Map<number, string>();
  const actors = { manager: 1, reader: 2, legacy: 3, generic: 4, store: 5, wrongPath: 6, wrongAuth: 7, second: 8 };
  const env = { APP_KEY: 'owned-shipping-http-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', NODE_ENV: 'test' } as unknown as Env;
  beforeEach(async () => {
    f = await shippingSettingsFixture(); Object.assign(env, f.env);
    await f.db.insert(systemMenus).values([
      { id: 1359, type: 1, authType: 1, access: 1, uniqueAuth: 'setting-distribution-deliver', menuPath: '/admin/setting/distribution/deliver' },
      { id: 13591, type: 1, authType: 1, access: 1, uniqueAuth: 'setting-distribution-deliver', menuPath: '/admin/setting/distribution/city_deliver' },
      { id: 13592, type: 1, authType: 1, access: 1, uniqueAuth: 'other-auth', menuPath: '/admin/setting/distribution/deliver' },
    ]);
    const rules: Record<string, string> = { manager: 'shipping_settings.manage', reader: 'shipping_settings.view', legacy: '1359', generic: 'config.manage',
      store: 'store.manage', wrongPath: '13591', wrongAuth: '13592', second: 'shipping_settings.manage' };
    await f.db.insert(systemRole).values(Object.entries(actors).map(([name, id]) => ({ id, type: 1, roleName: name, rules: rules[name] })));
    await f.db.insert(systemAdmin).values(Object.entries(actors).map(([name, id]) => ({ id, account: `shipping-${name}`, pwd: 'shipping-http-fixture',
      level: 1, roles: String(id), adminType: 1, status: 1, isDel: 0 })));
    for (const id of Object.values(actors)) tokens.set(id, (await createToken(id, 'admin', md5('shipping-http-fixture'), env.APP_KEY)).token);
  }, 30_000);
  afterEach(async () => { wiring.container = undefined; tokens.clear(); await f?.close(); }, 30_000);
  async function profiles(run: () => Promise<void>) {
    await f.withRuntimeRole(appPeer => f.withRuntimeRole(async adminPeer => {
      await f.installSlice(appPeer, adminPeer); wiring.container = createContainerFromDb(appPeer.db);
      Object.assign(env, { HYPERDRIVE: { connectionString: appPeer.connectionString }, HYPERDRIVE_ADMIN: { connectionString: adminPeer.connectionString } });
      try { await run(); } finally { wiring.container = undefined; }
    }));
  }
  async function request(prefix: string, actor: number | null, path = '', method = 'GET', body?: unknown, raw?: string) {
    const response = await app.request(`${prefix}/config/shipping${path}`, { method,
      headers: { ...(actor === null ? {} : { Authorization: `Bearer ${tokens.get(actor)}` }), ...(body === undefined && raw === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
    return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
  }
  it.each(['/adminapi', '/api/admin'])('executes GET/save/cities/receipt through %s with private responses and immutable actor receipts', async prefix => profiles(async () => {
    const page = await request(prefix, actors.manager); expect(page.body.status).toBe(200); expect(page.response.headers.get('Cache-Control')).toContain('no-store');
    const cities = await request(prefix, actors.reader, '/cities?pid=10'); expect(cities.body.data).toMatchObject([{ id: 11, label: '乙市' }]);
    const input = shippingSaveInput(page.body.data.revision), saved = await request(prefix, actors.manager, '', 'POST', input);
    expect(saved.body.status, saved.body.msg).toBe(200); expect(saved.body.data).toMatchObject({ operation: 'save', request_id: input.request_id });
    expect((await request(prefix, actors.manager, `/receipts/${input.request_id}`)).body.data).toEqual(saved.body.data);
    expect((await request(prefix, actors.manager, '', 'POST', input)).body.data).toEqual(saved.body.data);
    const unknown = await request(prefix, actors.manager, `/receipts/${crypto.randomUUID()}`); expect(unknown.response.status).toBe(404); expect(unknown.body.status).toBe(404);
    const other = await request(prefix, actors.second, `/receipts/${input.request_id}`); expect(other.response.status).toBe(404);
    expect((await request(prefix, actors.second, '', 'POST', input)).body.status).toBe(400);
    expect(await f.db.select().from(systemLog)).toHaveLength(1);
  }));
  it('isolates exact old page reads from every write and rejects broad config/store and malformed legacy identities', async () => profiles(async () => {
    const input = shippingSaveInput((await request('/adminapi', actors.manager)).body.data.revision);
    for (const prefix of ['/adminapi', '/api/admin']) {
      for (const actor of [actors.reader, actors.legacy]) {
        expect((await request(prefix, actor)).body.status).toBe(200); expect((await request(prefix, actor, '/cities?pid=0')).body.status).toBe(200);
        expect((await request(prefix, actor, '', 'POST', input)).body.status).toBe(400011);
      }
      for (const actor of [actors.generic, actors.store, actors.wrongPath, actors.wrongAuth]) {
        expect((await request(prefix, actor)).body.status).toBe(400011); expect((await request(prefix, actor, '', 'POST', input)).body.status).toBe(400011);
        expect((await request(prefix, actor, '/cities?pid=0')).body.status).toBe(400011);
      }
      expect((await request(prefix, null)).body.status).toBe(410000);
    }
    expect(await f.db.select().from(systemLog)).toEqual([]);
  }));
  it('rejects duplicate fields, exact-body violations and malformed city selectors before business writes', async () => profiles(async () => {
    const prefix = '/adminapi', page = await request(prefix, actors.manager), input = shippingSaveInput(page.body.data.revision);
    for (const path of ['?ignored=1', '/cities?pid=0&pid=1', '/cities?pid=0&extra=1', '/cities?pid=-1', '/cities?pid=01', '/cities?pid=1e1']) expect((await request(prefix, actors.manager, path)).body.status).toBe(400);
    for (const raw of ['{"request_id":"a","request_id":"b"}', '{"pickup":{"name":"x","name":"y"}}', `{"x":"${'中'.repeat(3000)}"}`]) {
      expect((await request(prefix, actors.manager, '', 'POST', undefined, raw)).body.status).toBe(400);
    }
    expect((await request(prefix, actors.manager, '', 'POST', { ...input, value: 'arbitrary' })).body.status).toBe(400);
    expect(await f.db.select().from(systemLog)).toEqual([]);
  }));
  it('returns only definite pre-DML CAS rejection as HTTP409 with matching immutable nonce/hash and unchanged complete business rows', async () => profiles(async () => {
    const snapshot = async () => ({ configs: await f.db.select().from(systemConfig).orderBy(systemConfig.id),
      stores: await f.db.select().from(systemStore).orderBy(systemStore.id), logs: await f.db.select().from(systemLog).orderBy(systemLog.id) });
    const before = await snapshot();
    for (const prefix of ['/adminapi', '/api/admin']) {
      const input = shippingSaveInput('a'.repeat(64)), result = await request(prefix, actors.manager, '', 'POST', input);
      expect(result.response.status).toBe(409); expect(result.response.headers.get('Cache-Control')).toContain('no-store');
      expect(result.body).toEqual({ status: 409, msg: '配送设置或默认提货点已变化，请重新读取并确认',
        data: { code: 'SHIPPING_SETTINGS_STALE_VERSION', request_id: input.request_id,
          payload_hash: await shippingSettingsHash(shippingSettingsCanonical(input).canonical) } });
      expect(await snapshot()).toEqual(before);
      const unknown = await request(prefix, actors.manager, `/receipts/${input.request_id}`); expect(unknown.response.status).toBe(404);
      const invalid = await request(prefix, actors.manager, '', 'POST', { ...input, unsupported: true });
      expect(invalid.response.status).toBe(200); expect(invalid.body.status).toBe(400); expect(invalid.body.data).toBeNull();
    }
  }));
  it('keeps corrupt or duplicate receipt results non-404 so a client cannot infer safe retry', async () => profiles(async () => {
    const requestId = crypto.randomUUID();
    await f.db.insert(systemLog).values({ type: 'shipping_settings', path: `/config/shipping/request/${requestId}`, adminId: 1, action: 'bad' });
    let result = await request('/adminapi', actors.manager, `/receipts/${requestId}`); expect(result.response.status).toBe(200); expect(result.body.status).toBe(400);
    await f.db.insert(systemLog).values({ type: 'shipping_settings', path: `/config/shipping/request/${requestId}`, adminId: 1, action: `save;payload=${'a'.repeat(64)}` });
    result = await request('/api/admin', actors.manager, `/receipts/${requestId}`); expect(result.response.status).toBe(200); expect(result.body.status).toBe(400);
  }));
});
