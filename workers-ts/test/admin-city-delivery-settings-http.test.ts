import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Env } from '../src/env';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import { systemAdmin, systemRole, systemMenus, systemConfig, systemLog } from '../src/models/schema';
import { createToken, md5 } from '../src/utils/jwt';
import { AdminPermissionService } from '../src/services/admin/AdminPermissionService';
import { CITY_DELIVERY_CREDENTIAL_KEYS } from '../../view/common/cityDeliverySettings';
import { cityDeliverySettingsFixture, citySettingsBindings, citySettingsInput } from './helpers/cityDeliverySettingsFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({ ...await original<typeof import('../src/lib/di')>(), createContainer: () => { if (!wiring.container) throw Error('Owned city HTTP fixture missing'); return wiring.container; } }));
const bindings = { ...citySettingsBindings, APP_KEY: 'owned-city-settings-http', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', NODE_ENV: 'test', CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} } } satisfies
  typeof citySettingsBindings & Pick<Env, 'APP_KEY' | 'UPSTASH_REDIS_URL' | 'UPSTASH_REDIS_TOKEN'> & { NODE_ENV: 'test'; CONFIG_KV: { get: (key: string) => Promise<null>; put: () => Promise<void>; delete: () => Promise<void> } };
// Only these checked bindings and real LOGIN connections are enabled. No provider bindings are fabricated.
const env = bindings as unknown as Env;
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('registered city settings HTTP, real JWT and independent production privilege intersection', () => {
  let f: Awaited<ReturnType<typeof cityDeliverySettingsFixture>>, tripwire: ReturnType<typeof vi.spyOn>;
  const app = createApp(), tokens = new Map<number, string>(), actors = { manager: 1, reader: 2, legacy: 3, generic: 4, wrongPath: 5, wrongAuth: 6, second: 8 };
  beforeEach(async () => { f = await cityDeliverySettingsFixture();
    await f.db.insert(systemMenus).values([{ id: 1490, type: 1, authType: 1, access: 1, uniqueAuth: 'setting-city-delivery-setting', menuPath: '/admin/setting/city/delivery/setting' },
      { id: 91001, type: 1, authType: 1, access: 1, uniqueAuth: 'setting-city-delivery-setting', menuPath: '/admin/setting/other' },
      { id: 91002, type: 1, authType: 1, access: 1, uniqueAuth: 'wrong-auth', menuPath: '/admin/setting/city/delivery/setting' }]);
    const rules: Record<string, string> = { manager: 'city_delivery_settings.manage', reader: 'city_delivery_settings.view', legacy: '1490', generic: 'config.manage,log.view', wrongPath: '91001', wrongAuth: '91002', second: 'city_delivery_settings.manage' };
    await f.db.insert(systemRole).values(Object.entries(actors).map(([name, id]) => ({ id, type: 1, roleName: name, rules: rules[name] })));
    await f.db.insert(systemAdmin).values(Object.entries(actors).map(([name, id]) => ({ id, account: `city-${name}`, pwd: 'owned-city-password', level: 1, roles: String(id), adminType: 1, status: 1, isDel: 0 })));
    for (const id of Object.values(actors)) tokens.set(id, (await createToken(id, 'admin', md5('owned-city-password'), bindings.APP_KEY)).token);
    tripwire = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Settings HTTP cannot call provider'));
  }, 30_000);
  afterEach(async () => { if (tripwire) expect(tripwire).not.toHaveBeenCalled(); vi.restoreAllMocks(); tokens.clear(); wiring.container = undefined; await f?.close(); }, 30_000);
  type Peer = Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0];
  const profiles = (run: (admin: Peer, appPeer: Peer) => Promise<void>) => f.withRuntimeRole(appPeer => f.withRuntimeRole(async admin => { await f.installSlice(appPeer, admin); wiring.container = createContainerFromDb(appPeer.db);
    Object.assign(env, { HYPERDRIVE: { connectionString: appPeer.connectionString } as Env['HYPERDRIVE'], HYPERDRIVE_ADMIN: { connectionString: admin.connectionString } as Env['HYPERDRIVE_ADMIN'] }); try { await run(admin, appPeer); } finally { wiring.container = undefined; } }));
  async function request(prefix: string, actor: number | null, suffix = '', method = 'GET', body?: unknown, raw?: string, path = '/config/city-delivery') {
    const response = await app.request(`${prefix}${path}${suffix}`, { method, headers: { ...(actor === null ? {} : { Authorization: `Bearer ${tokens.get(actor)}` }),
      ...(body === undefined && raw === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
    return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
  }
  const proof = (prepared: { request_id: string; client_nonce: string; payload_hash: string }) => ({ request_id: prepared.request_id, client_nonce: prepared.client_nonce, payload_hash: prepared.payload_hash });

  it.each(['/adminapi', '/api/admin'])('prepares, restores, confirms and replays without plaintext or ciphertext projection on %s', async prefix => profiles(async () => {
    const before = await f.snapshot(), initial = await request(prefix, actors.reader); expect(initial.body).toMatchObject({ status: 200, data: { editable: true, flags: { city_delivery_status: 0 }, credentials: { dada_app_key: { source: 'env', configured: true } } } }); expect(initial.response.headers.get('Cache-Control')).toContain('no-store'); expect(await f.snapshot()).toEqual(before);
    const input = citySettingsInput(initial.body.data.revision); input.credentials.dada_app_sercret = { action: 'replace', value: 'owned-new-http-private-secret' };
    const preparing = await request(prefix, actors.manager, '/intent', 'POST', input); expect(preparing.response.status).toBe(200); expect(preparing.body).toMatchObject({ status: 200, data: { state: 'prepared', intent_id: input.request_id, request_id: input.request_id, client_nonce: input.client_nonce, actions: { dada_app_sercret: 'replace' }, receipt: null } });
    const stored = await f.snapshot(); expect(stored.configs).toEqual(before.configs); expect(JSON.stringify(stored.logs)).not.toContain('owned-new-http-private-secret');
    expect((await request(prefix, actors.manager, `/intent/${input.request_id}`)).body.data).toEqual(preparing.body.data); expect((await request(prefix, actors.manager, `/request/${input.request_id}`)).response.status).toBe(404);
    const saved = await request(prefix, actors.manager, '/confirm', 'POST', proof(preparing.body.data)); expect(saved.body.status).toBe(200); const committed = await f.snapshot();
    expect((await request(prefix, actors.manager, `/request/${input.request_id}`)).body.data).toEqual(saved.body.data); expect((await request(prefix, actors.manager, '/confirm', 'POST', proof(preparing.body.data))).body.data).toEqual(saved.body.data); expect(await f.snapshot()).toEqual(committed);
    for (const output of [initial.body, preparing.body, saved.body, (await request(prefix, actors.manager, `/intent/${input.request_id}`)).body]) { const text = JSON.stringify(output); expect(text).not.toContain('owned-new-http-private-secret'); expect(text).not.toContain('city:v1:'); for (const key of CITY_DELIVERY_CREDENTIAL_KEYS) expect(output.data?.credentials?.[key]?.value).toBeUndefined(); }
  }));
  it('grants only exact legacy1490 view and modern manage in both prefixes, including actual single/batched menu lookup', async () => profiles(async admin => {
    const input = citySettingsInput((await request('/adminapi', actors.manager)).body.data.revision), before = await f.snapshot();
    for (const prefix of ['/adminapi', '/api/admin']) { for (const actor of [actors.reader, actors.legacy]) { expect((await request(prefix, actor)).body.status).toBe(200); expect((await request(prefix, actor, '/intent', 'POST', input)).body.status).toBe(400011); }
      for (const actor of [actors.generic, actors.wrongPath, actors.wrongAuth]) { expect((await request(prefix, actor)).body.status).toBe(400011); expect((await request(prefix, actor, '/intent', 'POST', input)).body.status).toBe(400011); } expect((await request(prefix, null)).body.status).toBe(410000); }
    const permissions = new AdminPermissionService(createContainerFromDb(admin.db)); expect(await permissions.resolveRulePermissionKeys('1490')).toEqual(['city_delivery_settings.view']); expect(await permissions.resolveManyRulePermissionKeys(['1490', '91001', '91002'])).toEqual([['city_delivery_settings.view'], [], []]);
    for (const patch of [{ type: 2 }, { authType: 2 }, { access: 0 }, { isDel: 1 }, { uniqueAuth: 'wrong' }, { menuPath: '/admin/setting/other' }]) { await f.db.update(systemMenus).set({ type: 1, authType: 1, access: 1, isDel: 0, uniqueAuth: 'setting-city-delivery-setting', menuPath: '/admin/setting/city/delivery/setting', ...patch }).where(eq(systemMenus.id, 1490)); expect(await permissions.resolveRulePermissionKeys('1490')).toEqual([]); expect(await permissions.resolveManyRulePermissionKeys(['1490'])).toEqual([[]]); }
    expect(await f.snapshot()).toEqual({ ...before, configs: before.configs, logs: before.logs });
  }));
  it.each(['/adminapi', '/api/admin'])('returns actual matched409 and expiry400 only after rollback on %s', async prefix => profiles(async () => {
    let input = citySettingsInput((await request(prefix, actors.manager)).body.data.revision), prepared = (await request(prefix, actors.manager, '/intent', 'POST', input)).body.data;
    await f.db.update(systemConfig).set({ info: 'peer full-CAS drift' }).where(eq(systemConfig.menuName, 'dada_app_key')); let before = await f.snapshot();
    const stale = await request(prefix, actors.manager, '/confirm', 'POST', proof(prepared)); expect(stale.response.status).toBe(409); expect(stale.body).toMatchObject({ status: 409, data: { code: 'CITY_DELIVERY_SETTINGS_STALE_VERSION', operation: 'update', ...proof(prepared) } }); expect(await f.snapshot()).toEqual(before);
    input = citySettingsInput((await request(prefix, actors.manager)).body.data.revision); prepared = (await request(prefix, actors.manager, '/intent', 'POST', input)).body.data; before = await f.snapshot(); vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1801_000);
    const expired = await request(prefix, actors.manager, '/confirm', 'POST', proof(prepared)); expect(expired.response.status).toBe(400); expect(expired.body).toMatchObject({ status: 400, data: { code: 'CITY_DELIVERY_SETTINGS_REJECTED', operation: 'update', ...proof(prepared) } }); expect(await f.snapshot()).toEqual(before); expect((await request(prefix, actors.manager, `/request/${input.request_id}`)).response.status).toBe(404);
  }));
  it('keeps raw parse, UUID conflict, nonce mismatch and corrupt encrypted storage outside rollback proof', async () => profiles(async () => {
    const input = citySettingsInput((await request('/adminapi', actors.manager)).body.data.revision), prepared = (await request('/adminapi', actors.manager, '/intent', 'POST', input)).body.data;
    let before = await f.snapshot(); for (const body of [{ ...proof(prepared), client_nonce: crypto.randomUUID() }, { ...proof(prepared), extra: true }, { ...proof(prepared), payload_hash: 'x' }]) { const result = await request('/adminapi', actors.manager, '/confirm', 'POST', body); expect(result.response.status).toBe(200); expect(result.body).toMatchObject({ status: 400, data: null }); }
    for (const raw of ['{bad', JSON.stringify(input).replace('"revision":', '"revision":"' + 'a'.repeat(64) + '","revision":'), ' '.repeat(16385)]) expect((await request('/api/admin', actors.manager, '/intent', 'POST', undefined, raw)).body).toMatchObject({ status: 400, data: null });
    expect((await request('/adminapi', actors.second, '/confirm', 'POST', proof(prepared))).body).toMatchObject({ status: 400, data: null }); expect(await f.snapshot()).toEqual(before);
    const part = before.logs.find(row => row.type === 'city_delivery_intent_part')!; await f.db.update(systemLog).set({ action: 'tampered' }).where(eq(systemLog.id, part.id)); before = await f.snapshot();
    const corrupted = await request('/api/admin', actors.manager, '/confirm', 'POST', proof(prepared)); expect(corrupted.response.status).toBe(200); expect(corrupted.body).toMatchObject({ status: 400, data: null }); expect(await f.snapshot()).toEqual(before);
  }));
  it('closes generic secret reads, ten-key batch writes and private log projections while leaving ordinary configuration usable', async () => profiles(async () => {
    await f.db.insert(systemConfig).values([{ menuName: '\tUUpt_appkey\u00a0', value: 'legacy-alias-plaintext' }, { menuName: 'owned_ordinary', value: '"ordinary"' }]);
    const snapshot = await request('/adminapi', actors.manager); expect(snapshot.body.data.editable).toBe(false); await f.db.delete(systemConfig).where(eq(systemConfig.menuName, '\tUUpt_appkey\u00a0'));
    const input = citySettingsInput((await request('/adminapi', actors.manager)).body.data.revision); input.credentials.uupt_appkey = { action: 'replace', value: 'http-private-log-value' }; await request('/adminapi', actors.manager, '/intent', 'POST', input);
    const before = await f.snapshot(), listed = await request('/api/admin', actors.generic, '', 'GET', undefined, undefined, '/config/list'); expect(listed.body.status).toBe(200); for (const row of listed.body.data) expect(CITY_DELIVERY_CREDENTIAL_KEYS).not.toContain(row.menuName);
    for (const prefix of ['/adminapi', '/api/admin']) { const getPath = prefix === '/adminapi' ? '/setting/config/' : '/config/';
      for (const key of ['dada_app_key', 'uupt_open_id', 'UUpt_appkey']) expect((await request(prefix, actors.generic, '', 'GET', undefined, undefined, getPath + key)).body).toMatchObject({ status: 400, data: null });
      const logs = await request(prefix, actors.generic, '', 'GET', undefined, undefined, '/log/list'); expect(logs.body.status).toBe(200); expect(logs.body.data.count).toBe(0); expect(JSON.stringify(logs.body)).not.toContain('city:v1:'); expect(JSON.stringify(logs.body)).not.toContain('http-private-log-value'); }
    for (const key of [...CITY_DELIVERY_CREDENTIAL_KEYS, 'city_delivery_status', 'self_delivery_status', 'dada_delivery_status', 'uu_delivery_status']) expect((await request('/api/admin', actors.generic, '', 'POST', { [key]: '1', owned_ordinary: 'bad' }, undefined, '/config/save')).body).toMatchObject({ status: 400, data: null });
    for (const prefix of ['/adminapi', '/api/admin']) expect((await request(prefix, actors.generic, '', 'POST', { sms_owned: 'must-not-write', UUpt_appkey: 'forged' }, undefined, '/sms/config')).body).toMatchObject({ status: 400, data: null });
    expect(await f.snapshot()).toEqual(before); expect((await request('/api/admin', actors.generic, '', 'GET', undefined, undefined, '/config/owned_ordinary')).body).toMatchObject({ status: 200, data: { value: 'ordinary' } });
  }));
  it('does not expose missing intents as application proofs and rejects queries, absent Admin bindings and unregistered legacy writes', async () => profiles(async () => {
    const before = await f.snapshot(); for (const prefix of ['/adminapi', '/api/admin']) { const uuid = crypto.randomUUID(); expect((await request(prefix, actors.manager, `/intent/${uuid}`)).response.status).toBe(404); expect((await request(prefix, actors.manager, `/request/${uuid}`)).response.status).toBe(404);
      expect((await request(prefix, actors.manager, '?x=1&x=1')).body).toMatchObject({ status: 400, data: null }); const unregistered = await request(prefix, actors.manager, '', 'PUT', { city_delivery_status: 1 }); expect(unregistered.body).toMatchObject({ status: prefix === '/adminapi' ? 501 : 404, data: null }); }
    const previous = env.HYPERDRIVE_ADMIN; delete (env as Partial<Env>).HYPERDRIVE_ADMIN; try { expect((await request('/api/admin', actors.manager)).body.status).not.toBe(200); } finally { env.HYPERDRIVE_ADMIN = previous; } expect(await f.snapshot()).toEqual(before);
  }));
});
