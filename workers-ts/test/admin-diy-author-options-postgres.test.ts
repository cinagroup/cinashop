import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresJsPreparedQuery } from 'drizzle-orm/postgres-js';
import type { PreparedQueryConfig } from 'drizzle-orm/pg-core';
import { storeProduct, systemDise } from '@/models/schema';
import { AdminFabLinkCatalogService } from '@/services/admin/AdminFabLinkCatalogService';
import { createContainerFromDb } from '@/lib/di';
import { AttachmentService } from '@/services/system/AttachmentService';
import { diyAuthorOptionsFixture } from './helpers/diyAuthorOptionsFixture';

const query = (kind: string, extra = '') => new URLSearchParams(`kind=${kind}${extra}`);
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('DIY author options actual PG16 SELECT projection', () => {
  let f: Awaited<ReturnType<typeof diyAuthorOptionsFixture>>;
  beforeEach(async () => { f = await diyAuthorOptionsFixture(); }, 30000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); }, 30000);
  async function runtime(run: (app: Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0], admin: Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0]) => Promise<void>) {
    await f.withRuntimeRole(app => f.withRuntimeRole(async admin => {
      await f.installSlice(app, admin); expect(app.pid).not.toBe(admin.pid);
      for (const peer of [app, admin]) {
        const [identity] = await peer.exec('SELECT current_user, session_user, current_setting(\'server_version_num\') AS version');
        expect(identity).toMatchObject({ current_user: peer.role, session_user: peer.role }); expect(Number(identity.version)).toBeGreaterThanOrEqual(160000);
      }
      await run(app, admin);
    }));
  }
  it('returns every visible platform word beyond twenty with exact id/name and unchanged full state/resources', async () => runtime(async (app, admin) => {
    const before = await f.snapshot(), resources = f.resources();
    for (const peer of [app, admin]) {
      const words = await f.authorFor(peer.db).hotWords(); expect(words.list).toHaveLength(25);
      expect(words.list.map(item => item.id)).toEqual(Array.from({ length: 25 }, (_, index) => 100 + index).sort((a, b) => ((b - 100) % 3) - ((a - 100) % 3) || b - a));
      expect(words.list.every(item => Object.keys(item).sort().join(',') === 'id,name')).toBe(true);
      expect(JSON.stringify(words)).not.toMatch(/private-style|hidden-word|supplier-word|foreign-platform|deleted-word/);
    }
    expect(await f.snapshot()).toEqual(before); expect(f.resources()).toEqual(resources);
  }));
  it('filters DIY before count/offset, retains broken diagnostics, typed identities and connected visible categories', async () => runtime(async (app, admin) => {
    const before = await f.snapshot(), resources = f.resources();
    for (const peer of [app, admin]) {
      const service = f.authorFor(peer.db), first = await service.tabTargets(query('special', '&limit=2'));
      expect(first).toMatchObject({ count: 5, page: 1, limit: 2 }); expect(first.list.map(item => item.id)).toEqual([109, 108]);
      expect((await service.tabTargets(query('special', '&limit=2&page=2'))).list.map(item => item.id)).toEqual([104, 102]);
      expect((await service.tabTargets(query('special', '&limit=2&page=3'))).list).toMatchObject([{ id: 101, selection: { kind: 'micro', id: 101, name: 'DIY微页一' } }]);
      expect((await service.tabTargets(query('special', '&search=损坏'))).list[0]).toMatchObject({ id: 104, selectable: false, selection: null });
      expect((await service.tabTargets(query('special', '&search=DIY微页一'))).list[0]).toMatchObject({ id: 101, selectable: true, selection: { kind: 'micro', id: 101, name: 'DIY微页一' } });
      const categories = await service.tabTargets(query('product_category'));
      expect(categories).toMatchObject({ count: 1, list: [{ id: 11, parent_id: 0, has_children: true, selection: { kind: 'category', id: 11, name: '服装' } }] });
      expect((await service.tabTargets(query('product_category', '&parent_id=11'))).list).toMatchObject([{ id: 12, selection: { kind: 'category', id: 12, name: '衬衫' } }]);
      for (const parent of [13, 14, 15, 16, 2147483647]) await expect(service.tabTargets(query('product_category', `&parent_id=${parent}`))).rejects.toThrow(/父分类/);
      expect((await service.tabTargets(query('special', '&page=101&limit=100'))).list).toEqual([]);
      expect((await service.tabTargets(query('special', '&search=%25_'))).count).toBe(0);
    }
    expect(await f.snapshot()).toEqual(before); expect(f.resources()).toEqual(resources);
  }));
  it('keeps all thirteen original projections and FAB non-DIY policy exact while signing only matching readable media', async () => runtime(async (_app, admin) => {
    const before = await f.snapshot(), resources = f.resources(), service = f.authorFor(admin.db);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const fab = new AdminFabLinkCatalogService(createContainerFromDb(admin.db), f.env);
    for (const category of (await service.linkCategories()).list) expect(await service.linkTargets(query(category.kind))).toEqual(await fab.targets(query(category.kind)));
    expect((await service.linkTargets(query('special'))).list.map(item => item.id)).toEqual([109, 108, 106, 104, 102, 101, 93, 91]);
    const tabs = await service.tabTargets(query('special'));
    for (const id of [109, 108]) expect(tabs.list.find(item => item.id === id)).toMatchObject({ selectable: true, image_preview: '', selection: { kind: 'micro', id } });
    const platforms = (await service.linkTargets(query('product'))).list, links = [platforms.find(item => item.id === 21)!, platforms.find(item => item.id === 23)!];
    for (const item of links) {
      const url = new URL(item.image_preview!, 'https://owned.test');
      expect(url.searchParams.get('signature')).toMatch(/^[A-Za-z0-9_-]+$/);
      const asset = await new AttachmentService(createContainerFromDb(admin.db), f.env).getSignedAsset(url.pathname.split('/').at(-1), url.searchParams.get('expires'), url.searchParams.get('signature'));
      expect(new Uint8Array(await asset.response.arrayBuffer())).toEqual(f.png);
      await expect(new AttachmentService(createContainerFromDb(admin.db), f.env).getSignedAsset(f.privateImage.att_id, url.searchParams.get('expires'), url.searchParams.get('signature'))).rejects.toThrow();
    }
    expect(JSON.stringify([tabs, platforms])).not.toMatch(/never expose|untouched-v1|private-info|not-serialized|keyword|"value"|"content"|"cover_image"|attachments\//);
    expect(await f.snapshot()).toEqual(before); expect(f.resources()).toEqual(resources);
  }));
  it('keeps count, DIY predicate and list in one actual repeatable-read snapshot during concurrent publishing', async () => runtime(async (_app, admin) => {
    const execute = PostgresJsPreparedQuery.prototype.execute; let inserted = false;
    vi.spyOn(PostgresJsPreparedQuery.prototype, 'execute').mockImplementation(async function (this: PostgresJsPreparedQuery<PreparedQueryConfig>, ...args) {
      const statement = this.getQuery().sql, result = await execute.apply(this, args);
      if (!inserted && statement.includes('SELECT count(*)::integer AS count FROM (') && statement.includes('public.system_dise d')) {
        inserted = true; await f.db.insert(systemDise).values({ id: 200, name: '并发发布DIY', type: 2, isDiy: 1, status: 1, value: '[]' });
        await f.db.insert(storeProduct).values({ id: 201, storeName: '无关商品', isVerify: 1 });
      }
      return result;
    });
    const result = await f.authorFor(admin.db).tabTargets(query('special'));
    expect(inserted).toBe(true); expect(result.count).toBe(5); expect(result.list.map(item => item.id)).not.toContain(200);
    vi.restoreAllMocks(); expect((await f.authorFor(admin.db).tabTargets(query('special'))).list[0]).toMatchObject({ id: 200, selection: { kind: 'micro', id: 200 } });
  }));
});
