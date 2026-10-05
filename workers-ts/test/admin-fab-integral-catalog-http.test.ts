import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { storeIntegral, storeProductDescription, systemAdmin, systemConfig, systemMenus, systemRole } from '../src/models/schema';
import { createToken, md5 } from '../src/utils/jwt';
import { fabIntegralCatalogFixture } from './helpers/fabIntegralCatalogFixture';
import { integralReadBindings } from './helpers/integralProductReadFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({ ...await original<typeof import('../src/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Owned integral chooser HTTP fixture unavailable'); return wiring.container;
} }));
const env = { ...integralReadBindings, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', NODE_ENV: 'test' } as unknown as Env;
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('FAB integral registered Admin HTTP with real read-only LOGINs', () => {
  let f: Awaited<ReturnType<typeof fabIntegralCatalogFixture>>, fetchGuard: ReturnType<typeof vi.spyOn>;
  const app = createApp(), tokens = new Map<number, string>();
  beforeEach(async () => {
    f = await fabIntegralCatalogFixture();
    await f.db.insert(systemMenus).values({ id: 1612, type: 1, authType: 1, access: 1, isDel: 0, menuPath: '/admin/setting/pages/fab', uniqueAuth: 'setting-system-fab' });
    const rules = ['fab_settings.view', '1612', 'config.manage,dise.manage,product.manage', 'fab_settings.manage'];
    await f.db.insert(systemRole).values(rules.map((rules, index) => ({ id: index + 1, type: 1, roleName: `Owned integral chooser ${index}`, rules, status: 1 })));
    await f.db.insert(systemAdmin).values(rules.map((_rules, index) => ({ id: index + 1, account: `integral-chooser-${index}`, pwd: 'owned-password', level: 1, roles: String(index + 1), adminType: 1, status: 1, isDel: 0 })));
    for (let id = 1; id <= 4; id++) tokens.set(id, (await createToken(id, 'admin', md5('owned-password'), env.APP_KEY)).token);
    fetchGuard = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Integral chooser must not contact image origins or providers'); });
  }, 30000);
  afterEach(async () => { if (fetchGuard) expect(fetchGuard).not.toHaveBeenCalled(); fetchGuard?.mockRestore(); tokens.clear(); wiring.container = undefined; await f?.close(); }, 30000);
  async function profiles(run: () => Promise<void>) {
    await f.withRuntimeRole(appPeer => f.withRuntimeRole(async adminPeer => {
      await f.installSelectSlice(appPeer, 'app'); await f.installSelectSlice(adminPeer, 'admin');
      expect(appPeer.pid).not.toBe(adminPeer.pid);
      for (const peer of [appPeer, adminPeer]) expect((await peer.exec('SELECT current_user,session_user'))[0]).toEqual({ current_user: peer.role, session_user: peer.role });
      wiring.container = createContainerFromDb(appPeer.db);
      Object.assign(env, { HYPERDRIVE: { connectionString: appPeer.connectionString }, HYPERDRIVE_ADMIN: { connectionString: adminPeer.connectionString } });
      try { await run(); } finally { wiring.container = undefined; }
    }));
  }
  async function request(prefix: string, actor: number | null, suffix = 'kind=integral&limit=100') {
    const response = await app.request(`${prefix}/setting/fab/link-targets?${suffix}`, { headers: actor === null ? {} : { Authorization: `Bearer ${tokens.get(actor)}` } }, env);
    return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
  }
  it.each(['/adminapi', '/api/admin'])('publishes actual activity links and scoped previews on %s without exposing private fields or changing any table', async prefix => profiles(async () => {
    await f.db.insert(storeIntegral).values({ id: 50, productId: 70, storeName: '正文超限积分' });
    await f.db.insert(storeProductDescription).values({ productId: 50, type: 4, description: 'x'.repeat(200001) });
    const before = await f.snapshot();
    for (const actor of [1, 2, 4]) {
      const result = await request(prefix, actor);
      expect(result.body.status, result.body.msg).toBe(200); expect(result.response.headers.get('Cache-Control')).toContain('no-store');
      expect(result.body.data.count).toBe(9); expect(result.body.data.list.map((row: { id: number }) => row.id)).toEqual([50,16,15,14,13,12,11,10,9]);
      for (const row of result.body.data.list) expect(row).toMatchObject({ selectable: row.id !== 50, partial: true, url: `/pages/activity/goods_details/index?id=${row.id}&type=4` });
      expect(result.body.data.list[0].issues).toEqual(expect.arrayContaining([expect.stringContaining('暂不可选择')]));
      expect(result.body.data.list.find((row: { id: number }) => row.id === 10).image_preview).toMatch(/^\/api\/assets\/41\?expires=\d+&signature=/);
      expect(result.body.data.list.find((row: { id: number }) => row.id === 11).image_preview).toMatch(/^\/api\/assets\/42\?expires=\d+&signature=/);
      expect(result.body.data.list.find((row: { id: number }) => row.id === 13).issues).toEqual(expect.arrayContaining([expect.stringContaining('为0')]));
      expect(result.body.data.list.find((row: { id: number }) => row.id === 12).image_preview).toBe('');
      const raw = JSON.stringify(result.body.data); for (const secret of ['PRIVATE', 'customForm', 'product_id', 'settlePrice', 'diskInfo', 'relation_id', 'cost']) expect(raw).not.toContain(secret);
    }
    expect(await f.snapshot()).toEqual(before);
  }));
  it('requires the dedicated FAB view authority and strictly rejects query ambiguity on both real prefixes', async () => profiles(async () => {
    for (const prefix of ['/adminapi', '/api/admin']) {
      expect((await request(prefix, null)).body.status).toBe(410000);
      expect((await request(prefix, 3)).body.status).toBe(400011);
      for (const suffix of ['kind=integral&kind=product', 'kind=integral&raw=1', 'kind=integral&parent_id=70', 'kind=integral&page=102&limit=100']) expect((await request(prefix, 1, suffix)).body.status).toBe(400);
      const filtered = await request(prefix, 1, 'kind=integral&search=门店积分&limit=1');
      expect(filtered.body.status, filtered.body.msg).toBe(200); expect(filtered.body.data).toMatchObject({ count: 1, page: 1, limit: 1, list: [{ id: 10 }] });
    }
    await f.db.insert(systemConfig).values(Array.from({ length: 1001 }, (_, index) => ({ id: 2000 + index, menuName: 'site_name', value: '"过量配置"' })));
    for (const prefix of ['/adminapi', '/api/admin']) {
      const failure = await request(prefix, 1); expect(failure.body.status).toBe(400); expect(failure.body.msg).toContain('积分详情展示配置超过完整容量');
      expect(failure.body.data?.list).toBeUndefined();
    }
  }));
});
