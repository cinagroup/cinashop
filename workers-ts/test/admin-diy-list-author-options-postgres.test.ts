import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { PostgresJsPreparedQuery } from 'drizzle-orm/postgres-js';
import type { PreparedQueryConfig } from 'drizzle-orm/pg-core';
import { storeBrand, storeProduct } from '@/models/schema';
import { createContainerFromDb } from '@/lib/di';
import { AdminFabLinkCatalogService } from '@/services/admin/AdminFabLinkCatalogService';
import { AttachmentService } from '@/services/system/AttachmentService';
import { diyListAuthorOptionsFixture } from './helpers/diyListAuthorOptionsFixture';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('list author catalogs on actual distinct PG16 app/Admin LOGINs', () => {
  let f: Awaited<ReturnType<typeof diyListAuthorOptionsFixture>>;
  beforeEach(async () => { f = await diyListAuthorOptionsFixture(); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned list catalogs forbid external I/O')); }, 30000);
  afterEach(async () => { if (vi.isMockFunction(fetch)) expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); await f?.close(); }, 30000);
  async function profiles(work: (app: Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0], admin: Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0]) => Promise<void>) {
    await f.withRuntimeRole(app => f.withRuntimeRole(async admin => {
      await f.installSlice(app, admin); expect(app.pid).not.toBe(admin.pid);
      for (const peer of [app, admin]) {
        const [identity] = await peer.exec('SELECT current_user,session_user,current_setting(\'server_version_num\') AS version');
        expect(identity).toMatchObject({ current_user: peer.role, session_user: peer.role }); expect(Number(identity.version)).toBeGreaterThanOrEqual(160000);
      }
      await work(app, admin);
    }));
  }
  async function unchanged<T>(read: () => Promise<T>) { const before = await f.snapshot(), resources = f.resources(), result = await read(); expect(await f.snapshot()).toEqual(before); expect(f.resources()).toEqual(resources); return result; }
  it('returns paged actual platform brands with every ancestor visible, max three levels and no orphan/cycle/store leakage', async () => profiles(async (app, admin) => {
    for (const peer of [app, admin]) await unchanged(async () => {
      const service = f.listFor(peer.db), first = await service.brands(new URLSearchParams('limit=1'));
      expect(first).toMatchObject({ count: 4, page: 1, limit: 1, list: [{ id: 3101, parent_id: 0, has_children: true, selection: { kind: 'brand', id: 3101, name: '可见品牌' } }] });
      expect((await service.brands(new URLSearchParams('limit=1&page=2'))).list.map(r => r.id)).toEqual([3113]);
      expect((await service.brands(new URLSearchParams('parent_id=3101'))).list).toMatchObject([{ id: 3102, has_children: true }]);
      expect((await service.brands(new URLSearchParams('parent_id=3102'))).list).toMatchObject([{ id: 3103, has_children: false }]);
      expect((await service.brands(new URLSearchParams('parent_id=3103'))).list).toEqual([]);
      for (const id of [3104,3105,3106,3107,3108,3109,3110,3111,3112,2147483647]) await expect(service.brands(new URLSearchParams('parent_id='+id))).rejects.toThrow(/父品牌/);
      expect((await service.brands(new URLSearchParams('search=%25_'))).list.map(r => r.id)).toEqual([3113]);
      expect((await service.brands(new URLSearchParams('search=3120'))).list).toMatchObject([{ id: 3120, name: '品牌 3120' }]);
      expect((await service.brands(new URLSearchParams('page=101&limit=100'))).list).toEqual([]);
    });
  }));
  it('reads only visible platform labels and actual public article categories plus explicit hot0 without leaking bodies/styles/owner metadata', async () => profiles(async (app, admin) => {
    for (const peer of [app, admin]) await unchanged(async () => {
      const service = f.listFor(peer.db), labels = await service.labels(new URLSearchParams()), categories = await service.articleCategories(new URLSearchParams());
      expect(labels.list.map(r => r.id)).toEqual([3201,3206,3220]); expect(labels.list[0]).toEqual({ id: 3201, name: '可见标签', selection: { kind: 'label', id: 3201, name: '可见标签' } });
      expect((await service.labels(new URLSearchParams('search=%25_'))).list.map(r => r.id)).toEqual([3206]);
      expect(categories.list.map(r => r.id)).toEqual([0,3301,3306,3307,3305,71]);
      expect(categories.list[0]).toEqual({ id: 0, name: '热门', aggregate: true, selection: { kind: 'article_category', id: 0, name: '热门' } });
      expect(categories.list.slice(1).every(r => !r.aggregate && r.id>0)).toBe(true);
      expect((await service.articleCategories(new URLSearchParams('search=%25_'))).list.map(r => r.id)).toEqual([3306]);
      expect((await service.articleCategories(new URLSearchParams('search=热门'))).list.map(r => r.id)).toEqual([0]);
      expect((await service.articleCategories(new URLSearchParams('limit=2&page=2'))).list.map(r => r.id)).toEqual([3306,3307]);
      expect(JSON.stringify([labels,categories])).not.toMatch(/javascript|never-label|icon|relation_id|store_id|伪造|负数|隐藏|禁用|供应商|停用|删除/);
    });
  }));
  it('adds typed product identity to the exact old FAB projection and proves actual persisted-owner PNG readability without cost/keyword disclosure', async () => profiles(async (_app, admin) => {
    await unchanged(async () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.now());
      const service = f.listFor(admin.db), actual = await service.products(new URLSearchParams()), previous = await new AdminFabLinkCatalogService(createContainerFromDb(admin.db), f.env).targets(new URLSearchParams('kind=product'));
      expect(actual.list.map(({ selection: _selection, ...row }) => row)).toEqual(previous.list);
      expect(actual.list.filter(r => r.selectable).every(r => r.selection?.kind==='product'&&r.selection.id===r.id&&r.selection.name===r.name)).toBe(true);
      expect(actual.list.map(r=>r.id)).toEqual([29,23,22,21]);
      expect((await service.products(new URLSearchParams('search=SKU-catalog-22'))).list.map(r=>r.id)).toEqual([22]);
      expect((await service.products(new URLSearchParams('parent_id=11'))).list.map(r=>r.id)).toEqual([21]);
      for (const id of [21,23]) {
        const item = actual.list.find(r=>r.id===id)!, url = new URL(item.image_preview!, 'https://owned.test');
        const asset = await new AttachmentService(createContainerFromDb(admin.db), f.env).getSignedAsset(url.pathname.split('/').at(-1),url.searchParams.get('expires'),url.searchParams.get('signature'));
        expect(new Uint8Array(await asset.response.arrayBuffer())).toEqual(f.png);
        await expect(new AttachmentService(createContainerFromDb(admin.db), f.env).getSignedAsset(f.privateImage.att_id,url.searchParams.get('expires'),url.searchParams.get('signature'))).rejects.toThrow();
      }
      expect(JSON.stringify(actual)).not.toMatch(/private-info|not-serialized|keyword|bar_code|cost|attachments\//);
    });
  }));
  it('rechecks product picture ownership while retaining selectable public product identity and rejects wider/ambiguous queries atomically', async () => profiles(async (_app, admin) => {
    await f.db.update(storeProduct).set({ image: f.privateImage.url }).where(eq(storeProduct.id,21));
    await unchanged(async () => {
      const service = f.listFor(admin.db), row = (await service.products(new URLSearchParams('search=普通商品'))).list[0];
      expect(row).toMatchObject({ id:21,image_preview:'',selectable:true,selection:{kind:'product',id:21} }); expect(row.issues).toContain('目标图片不可用，链接身份仍以目录记录为准');
      for (const query of ['kind=news','limit=0','page=1&page=2','parent_id=-1','owner_id=77']) await expect(service.products(new URLSearchParams(query))).rejects.toThrow();
      for (const method of [service.brands.bind(service),service.labels.bind(service),service.articleCategories.bind(service)]) {
        await expect(method(new URLSearchParams('status=0'))).rejects.toThrow();
        expect((await method(new URLSearchParams('search=%27%3BDELETE%20FROM%20store_brand%3B--'))).list).toEqual([]);
      }
    });
  }));
  it('keeps brand count/list in one actual RR read-only snapshot when an independent maintenance writer publishes between them', async () => profiles(async (_app, admin) => {
    const execute = PostgresJsPreparedQuery.prototype.execute; let inserted = false;
    const observe = vi.spyOn(PostgresJsPreparedQuery.prototype,'execute').mockImplementation(async function(this:PostgresJsPreparedQuery<PreparedQueryConfig>,...args){
      const statement=this.getQuery().sql,result=await execute.apply(this,args);
      if(!inserted&&statement.includes('SELECT count(*)::integer AS count')&&statement.includes('visible_brands')){inserted=true;await f.db.insert(storeBrand).values({id:3199,brandName:'并发新品牌',sort:1000});}
      return result;
    });
    const actual=await f.listFor(admin.db).brands(new URLSearchParams());expect(inserted).toBe(true);expect(actual.count).toBe(4);expect(actual.list.some(r=>r.id===3199)).toBe(false);
    observe.mockRestore();const fresh=await f.listFor(admin.db).brands(new URLSearchParams());expect(fresh.count).toBe(5);expect(fresh.list[0].id).toBe(3199);
  }));
});
