import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/app';
import { createContainerFromDb, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { systemAdmin, systemMenus, systemRole } from '@/models/schema';
import { AdminPermissionService, DISE_AUTHOR_SELECTION_PERMISSION } from '@/services/admin/AdminPermissionService';
import { createToken, md5 } from '@/utils/jwt';
import { diyAuthorOptionsFixture } from './helpers/diyAuthorOptionsFixture';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({ ...await original<typeof import('../src/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Owned DIY author HTTP fixture unavailable'); return wiring.container;
} }));
const resources = ['hot-words', 'link-categories', 'link-targets?kind=product', 'tab-categories', 'tab-targets?kind=special'];
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('registered DIY author HTTP/JWT with actual app/Admin LOGINs', () => {
  const app = createApp(), tokens = new Map<number, string>();
  let f: Awaited<ReturnType<typeof diyAuthorOptionsFixture>>, env: Env, guard: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    f = await diyAuthorOptionsFixture(); env = f.env;
    await f.db.insert(systemMenus).values([
      { id: 9711, type: 1, authType: 2, access: 1, isDel: 0, apiUrl: '/adminapi/dise/author-options/hot-words', methods: 'GET' },
      { id: 9712, type: 1, authType: 2, access: 1, isDel: 0, apiUrl: '/api/admin/dise/author-options/tab-targets', methods: 'POST' },
      { id: 9713, type: 1, authType: 2, access: 1, isDel: 0, apiUrl: '/adminapi/dise/author-options/unknown', methods: 'GET' },
    ]);
    const rules = ['dise.manage', 'dise.view', 'product.manage,config.manage,fab_settings.manage,attachment.manage', '9711', '9712', '9713', DISE_AUTHOR_SELECTION_PERMISSION];
    await f.db.insert(systemRole).values(rules.map((rules, index) => ({ id: index + 1, roleName: `Owned author ${index}`, rules, status: 1, type: 1 })));
    await f.db.insert(systemAdmin).values(rules.map((_rules, index) => ({ id: index + 1, account: `author-${index}`, pwd: 'owned-author-password',
      level: 1, roles: String(index + 1), adminType: 1, status: 1, isDel: 0 })));
    for (let id = 1; id <= rules.length; id++) tokens.set(id, (await createToken(id, 'admin', md5('owned-author-password'), env.APP_KEY)).token);
    guard = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('DIY author options must not call external providers or origins'); });
  }, 30000);
  afterEach(async () => { if (guard) expect(guard).not.toHaveBeenCalled(); guard?.mockRestore(); wiring.container = undefined; tokens.clear(); await f?.close(); }, 30000);
  async function profiles(run: () => Promise<void>) {
    await f.withRuntimeRole(appPeer => f.withRuntimeRole(async adminPeer => {
      await f.installSlice(appPeer, adminPeer); expect(appPeer.pid).not.toBe(adminPeer.pid);
      wiring.container = createContainerFromDb(appPeer.db);
      Object.assign(env, { HYPERDRIVE: { connectionString: appPeer.connectionString }, HYPERDRIVE_ADMIN: { connectionString: adminPeer.connectionString } });
      try { await run(); } finally { wiring.container = undefined; }
    }));
  }
  async function request(prefix: string, actor: number | null, resource: string, method = 'GET') {
    const response = await app.request(`${prefix}/dise/author-options/${resource}`, { method,
      headers: actor === null ? {} : { Authorization: `Bearer ${tokens.get(actor)}` } }, env);
    return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
  }
  it.each(['/adminapi', '/api/admin'])('reads all five real resources and all thirteen targets with complete state/resources unchanged on %s', async prefix => profiles(async () => {
    const before = await f.snapshot(), beforeResources = f.resources();
    for (const resource of resources) {
      const result = await request(prefix, 1, resource); expect(result.body.status, result.body.msg).toBe(200);
      expect(result.response.headers.get('Cache-Control')).toBe('private, no-store');
    }
    const words = await request(prefix, 1, 'hot-words'); expect(words.body.data.list).toHaveLength(25);
    const catalog = await request(prefix, 1, 'link-categories'); expect(catalog.body.data.list).toHaveLength(13);
    for (const category of catalog.body.data.list) {
      const result = await request(prefix, 1, `link-targets?kind=${category.kind}`); expect(result.body.status, `${category.kind}:${result.body.msg}`).toBe(200);
      expect(result.body.data).toMatchObject({ page: 1, limit: 15 });
    }
    const typed = await request(prefix, 1, 'tab-targets?kind=special&limit=1&page=5');
    expect(typed.body.data).toMatchObject({ count: 5, list: [{ id: 101, selection: { kind: 'micro', id: 101, name: 'DIY微页一' } }] });
    const category = await request(prefix, 1, 'tab-targets?kind=product_category&parent_id=11');
    expect(category.body.data.list).toMatchObject([{ id: 12, selection: { kind: 'category', id: 12, name: '衬衫' } }]);
    const product = await request(prefix, 1, 'link-targets?kind=product&search=供应商商品');
    const signed = product.body.data.list[0].image_preview, asset = await app.request(signed, {}, env);
    expect(asset.status).toBe(200); expect(asset.headers.get('Cache-Control')).toBe('private, no-store');
    expect(new Uint8Array(await asset.arrayBuffer())).toEqual(f.png);
    const forged = new URL(signed, 'https://owned.test'); forged.pathname = f.privateImage.url;
    expect((await app.request(forged.pathname + forged.search, {}, env)).status).toBe(404);
    expect(await f.snapshot()).toEqual(before); expect(f.resources()).toEqual(beforeResources);
  }));
  it('denies guests, viewers, adjacent managers, persisted fake virtual strings and accidental write/unknown legacy menus', async () => profiles(async () => {
    const before = await f.snapshot(), beforeResources = f.resources();
    for (const prefix of ['/adminapi', '/api/admin']) for (const resource of resources) {
      expect((await request(prefix, null, resource)).body.status).toBe(410000);
      for (const actor of [2, 3, 5, 6, 7]) expect((await request(prefix, actor, resource)).body.status, `${prefix}:${actor}:${resource}`).toBe(400011);
      expect((await request(prefix, 4, resource)).body.status).toBe(200);
    }
    for (const prefix of ['/adminapi', '/api/admin']) {
      const headers = { Authorization: `Bearer ${tokens.get(4)}` };
      const save = await app.request(prefix + '/dise/save', { method: 'POST', headers }, env);
      expect((await save.json<{ status: number }>()).status).toBe(400011);
      expect((await request(prefix, 1, 'unknown')).body.status).not.toBe(200);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) for (const resource of resources) expect((await request(prefix, 1, resource, method)).body.status).not.toBe(200);
      const fab = await app.request(prefix + '/setting/fab/link-targets?kind=product', { headers: { Authorization: `Bearer ${tokens.get(1)}` } }, env);
      expect((await fab.json<{ status: number }>()).status).toBe(400011);
      const gallery = await app.request(prefix + (prefix === '/adminapi' ? '/file/file' : '/assets'), { headers: { Authorization: `Bearer ${tokens.get(1)}` } }, env);
      expect((await gallery.json<{ status: number }>()).status).toBe(400011);
    }
    const permission = new AdminPermissionService(f.container);
    expect(await permission.resolveManyRulePermissionKeys(['9711', '9712', '9713', DISE_AUTHOR_SELECTION_PERMISSION])).toEqual([[DISE_AUTHOR_SELECTION_PERMISSION], [], [], []]);
    for (const [index, rule] of ['9711', '9712', '9713', DISE_AUTHOR_SELECTION_PERMISSION].entries()) expect(await permission.resolveRulePermissionKeys(rule)).toEqual(index === 0 ? [DISE_AUTHOR_SELECTION_PERMISSION] : []);
    expect(await f.snapshot()).toEqual(before); expect(f.resources()).toEqual(beforeResources);
  }));
  it('rejects duplicate, malformed, private-scope and oversized queries without mutation or fallback', async () => profiles(async () => {
    const before = await f.snapshot(), beforeResources = f.resources();
    const malformed = ['hot-words?limit=20', 'hot-words?type=2&relation_id=77', 'link-categories?kind=product', 'tab-categories?parent_id=0',
      'link-targets?kind=product&kind=news', 'link-targets?kind=product&owner_id=77', 'link-targets?kind=product&search=%00',
      'tab-targets?kind=product', 'tab-targets?kind=special&page=0', 'tab-targets?kind=special&page=01', 'tab-targets?kind=special&limit=101',
      'tab-targets?kind=special&page=102&limit=100', 'tab-targets?kind=special&parent_id=11', 'tab-targets?kind=product_category&parent_id=16',
      'tab-targets?kind=product_category&parent_id=2147483648', 'tab-targets?kind=special&search=' + 'x'.repeat(101)];
    for (const prefix of ['/adminapi', '/api/admin']) {
      for (const resource of malformed) expect((await request(prefix, 1, resource)).body.status, resource).toBe(400);
      const injected = await request(prefix, 1, 'tab-targets?kind=special&search=' + encodeURIComponent("' OR 1=1 --"));
      expect(injected.body.status).toBe(200); expect(injected.body.data).toMatchObject({ count: 0, list: [] });
    }
    expect(await f.snapshot()).toEqual(before); expect(f.resources()).toEqual(beforeResources);
  }));
});
