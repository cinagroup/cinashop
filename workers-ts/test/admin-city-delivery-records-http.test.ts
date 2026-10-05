import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { systemAdmin, systemMenus, systemRole } from '../src/models/schema';
import { createToken, md5 } from '../src/utils/jwt';
import { cityDeliveryRecordFixture } from './helpers/cityDeliveryRecordFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
type CityRecordHttpTestBindings = Pick<Env, 'APP_KEY' | 'UPSTASH_REDIS_URL' | 'UPSTASH_REDIS_TOKEN'> & { NODE_ENV: 'test' };
vi.mock('../src/lib/di', async original => ({ ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Owned city-record HTTP fixture unavailable'); return wiring.container; } }));
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('registered city-delivery records, real Admin JWT and readonly runtime LOGINs', () => {
  let f: Awaited<ReturnType<typeof cityDeliveryRecordFixture>>;
  const app = createApp(), tokens = new Map<number, string>();
  const actors = { reader: 1, legacy: 2, order: 3, config: 4, store: 5, wrongPath: 6, wrongAuth: 7, nonexistentManage: 8 };
  // Generated production bindings fix NODE_ENV='production'. This test uses
  // 'test', injects only JWT/owned SQL bindings, and disables every other
  // payment/KV/assets/queue dependency; the fetch tripwire remains mandatory.
  const env = ({ APP_KEY: 'owned-city-record-http-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', NODE_ENV: 'test' } satisfies CityRecordHttpTestBindings) as unknown as Env;
  beforeEach(async () => {
    f = await cityDeliveryRecordFixture(); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Record reads have no provider I/O'));
    await f.db.insert(systemMenus).values([
      { id: 1491, type: 1, authType: 1, access: 1, uniqueAuth: 'setting-city-delivery-record', menuPath: '/admin/setting/city/delivery/record' },
      { id: 14911, type: 1, authType: 1, access: 1, uniqueAuth: 'setting-city-delivery-record', menuPath: '/admin/setting/city/delivery/setting' },
      { id: 14912, type: 1, authType: 1, access: 1, uniqueAuth: 'other-auth', menuPath: '/admin/setting/city/delivery/record' },
    ]);
    const rules: Record<string, string> = { reader: 'city_delivery_record.view', legacy: '1491', order: 'order.manage', config: 'config.manage',
      store: 'store.manage', wrongPath: '14911', wrongAuth: '14912', nonexistentManage: 'city_delivery_record.manage' };
    await f.db.insert(systemRole).values(Object.entries(actors).map(([name, id]) => ({ id, type: 1, roleName: name, rules: rules[name] })));
    await f.db.insert(systemAdmin).values(Object.entries(actors).map(([name, id]) => ({ id, account: `city-record-${name}`, pwd: 'city-record-http-fixture',
      level: 1, roles: String(id), adminType: 1, status: 1, isDel: 0 })));
    for (const id of Object.values(actors)) tokens.set(id, (await createToken(id, 'admin', md5('city-record-http-fixture'), env.APP_KEY)).token);
  }, 30_000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { wiring.container = undefined; tokens.clear(); vi.restoreAllMocks(); await f?.close(); } }, 30_000);
  async function profiles(run: () => Promise<void>) {
    await f.withRuntimeRole(appPeer => f.withRuntimeRole(async adminPeer => {
      await f.installReadSlice(appPeer, adminPeer); wiring.container = createContainerFromDb(appPeer.db);
      Object.assign(env, { HYPERDRIVE: { connectionString: appPeer.connectionString }, HYPERDRIVE_ADMIN: { connectionString: adminPeer.connectionString } });
      try { await run(); } finally { wiring.container = undefined; }
    }));
  }
  async function request(prefix: string, actor: number | null, path = '/records', method = 'GET') {
    const response = await app.request(`${prefix}/city_delivery${path}`, { method,
      headers: actor === null ? {} : { Authorization: `Bearer ${tokens.get(actor)}` } }, env);
    return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
  }
  it.each(['/adminapi', '/api/admin'])('executes bounded list/detail/store reads through %s with exact projections, real SQL and no writes', async prefix => profiles(async () => {
    const before = await f.snapshot(), list = await request(prefix, actors.reader);
    expect(list.response.status).toBe(200); expect(list.body.status, list.body.msg).toBe(200); expect(list.response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(list.body.data).toMatchObject({ total: 10, page: 1, limit: 20 });
    const literal = await request(prefix, actors.reader, `/records?${new URLSearchParams({ keyword: '%_\\' })}`);
    expect(literal.body.data.items.map((row: { id: number }) => row.id)).toEqual([10, 2]);
    const detail = await request(prefix, actors.reader, '/records/2'); expect(detail.body.status).toBe(200); expect(detail.body.data.record.origin_order.order_id).toBe('origin-store%_\\');
    expect(detail.body.data.metadata.receiver_phone).toBe('13800138000'); expect(detail.response.headers.get('Cache-Control')).toContain('no-store');
    const stores = await request(prefix, actors.reader, '/stores?limit=1'); expect(stores.body.data).toMatchObject({ total: 3, limit: 1 }); expect(stores.body.data.items).toHaveLength(1);
    for (const privateField of ['finish_code', 'private-finish-code', 'private-coordinate', 'private-store-bank', 'private-supplier-bank', 'foreign-uid-order']) expect(JSON.stringify({ list: list.body, detail: detail.body, stores: stores.body })).not.toContain(privateField);
    expect(await f.snapshot()).toEqual(before);
  }));
  it('grants only explicit view or the precise old1491 auth/path pair and denies broad order/config/store or invented manage keys', async () => profiles(async () => {
    const before = await f.snapshot();
    for (const prefix of ['/adminapi', '/api/admin']) {
      for (const actor of [actors.reader, actors.legacy]) for (const path of ['/records', '/records/2', '/stores']) expect((await request(prefix, actor, path)).body.status).toBe(200);
      for (const actor of [actors.order, actors.config, actors.store, actors.wrongPath, actors.wrongAuth, actors.nonexistentManage]) for (const path of ['/records', '/records/2', '/stores']) expect((await request(prefix, actor, path)).body.status).toBe(400011);
      expect((await request(prefix, null)).body.status).toBe(410000);
      const response = await app.request(`${prefix}/city_delivery/records/2`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.get(actors.reader)}` } }, env);
      // Existing compatibility catch-all and app.notFound both use HTTP200.
      // Assert their exact envelopes; this must never become a write handler.
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(prefix === '/adminapi'
        ? { status: 501, msg: '接口 /adminapi/city_delivery/records/2 尚未迁移到 Workers', data: null }
        : { status: 404, msg: 'not found', data: null });
    }
    expect(await f.snapshot()).toEqual(before);
  }));
  it('rejects duplicate, unknown and noncanonical selectors on all three operations before any read projection', async () => profiles(async () => {
    const before = await f.snapshot();
    for (const prefix of ['/adminapi', '/api/admin']) for (const path of [
      '/records?status=1&status=0', '/records?keyword=a&keyword=b', '/records?unknown=1', '/records?status=-0', '/records?station_type=0',
      '/records?store_id=0', '/records?date_from=1', '/records?date_from=2&date_to=1', '/records?limit=101', '/records?page=1002&limit=100',
      '/records?keyword=%0Aabc', '/records/02', '/records/0', '/records/2?anything=1', '/stores?limit=51', '/stores?keyword=a&keyword=b', '/stores?status=1',
    ]) { const result = await request(prefix, actors.reader, path); expect(result.body.status, path).toBe(400); expect(result.body.data).toBeNull(); expect(result.response.headers.get('Cache-Control')).toContain('no-store'); }
    expect(await f.snapshot()).toEqual(before);
  }));
  it('returns actual404 for absent record and preserves orphan/owner mismatch diagnostics without disclosing a foreign original number', async () => profiles(async () => {
    for (const prefix of ['/adminapi', '/api/admin']) {
      const absent = await request(prefix, actors.reader, '/records/999'); expect(absent.response.status).toBe(404); expect(absent.body.status).toBe(404); expect(absent.body.data).toBeNull();
      const orphan = await request(prefix, actors.reader, '/records/5'); expect(orphan.body.data.record).toMatchObject({ origin_order: null, issues: ['owner_missing', 'origin_order_missing'] });
      const mismatch = await request(prefix, actors.reader, '/records/6'); expect(mismatch.body.data.record).toMatchObject({ origin_order: null, issues: ['status_ambiguous', 'origin_uid_mismatch'] });
      const foreignSearch = await request(prefix, actors.reader, '/records?keyword=foreign-uid-order'); expect(foreignSearch.body.data.total).toBe(0);
    }
  }));
});
