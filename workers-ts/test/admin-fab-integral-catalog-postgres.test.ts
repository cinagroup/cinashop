import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { storeIntegral, storeProductAttr, storeProductAttrValue, storeProductDescription, systemConfig } from '../src/models/schema';
import { AdminFabLinkCatalogService } from '../src/services/admin/AdminFabLinkCatalogService';
import { ValidateException } from '../src/utils/errors';
import { fabIntegralCatalogFixture } from './helpers/fabIntegralCatalogFixture';
import { observeIntegralReadDb } from './helpers/integralProductReadFixture';
import { waitForFinanceBlock } from './helpers/financePeers';

const query = () => new URLSearchParams('kind=integral&limit=100');
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('FAB integral actual detail and SELECT-only runtime authority', () => {
  let f: Awaited<ReturnType<typeof fabIntegralCatalogFixture>>;
  beforeEach(async () => { f = await fabIntegralCatalogFixture(); }, 30000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); }, 30000);
  async function profiles(run: (app: Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0], admin: Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0]) => Promise<void>) {
    await f.withRuntimeRole(app => f.withRuntimeRole(async admin => {
      await f.installSelectSlice(app, 'app'); await f.installSelectSlice(admin, 'admin');
      expect(app.pid).not.toBe(admin.pid);
      for (const peer of [app, admin]) {
        expect((await peer.exec('SELECT current_user,session_user'))[0]).toEqual({ current_user: peer.role, session_user: peer.role });
        expect((await peer.exec("SELECT has_table_privilege(current_user,'public.store_integral','INSERT') AS insert_allowed"))[0].insert_allowed).toBe(false);
      }
      await run(app, admin);
    }));
  }
  it('shares real detail visibility and media ownership for platform, store and supplier copies while excluding nonpublic or foreign identities', async () => profiles(async (app, admin) => {
    const before = await f.snapshot();
    for (const peer of [app, admin]) {
      const list = await f.catalogFor(peer.db).targets(query());
      expect(list.count).toBe(8); expect(list.list.map(row => row.id)).toEqual([16,15,14,13,12,11,10,9]);
      for (const id of [9,10,11,12,13,14,15,16]) {
        const detail = await f.serviceFor(peer.db).read(id), target = list.list.find(row => row.id === id)!;
        expect(target).toMatchObject({ id, selectable: true, partial: true, url: `/pages/activity/goods_details/index?id=${id}&type=4` });
        if (id !== 16) expect(target.name).toBe(detail.storeInfo.storeName);
        else { expect(detail.storeInfo.storeName).toBe(''); expect(target.name).toBe('积分商品'); }
        const imageIdentity = (image: string) => image ? new URL(image, 'https://owned.invalid').pathname : '';
        expect(imageIdentity(target.image_preview ?? '')).toBe(imageIdentity(detail.storeInfo.image));
        if (id !== 14) expect(target.price).toBe(detail.storeInfo.price);
      }
      expect(list.list.find(row => row.id === 10)?.image_preview).toMatch(/^\/api\/assets\/41\?expires=\d+&signature=/);
      expect(list.list.find(row => row.id === 11)?.image_preview).toMatch(/^\/api\/assets\/42\?expires=\d+&signature=/);
      for (const id of [12,15]) expect(list.list.find(row => row.id === id)).toMatchObject({ selectable: true, image_preview: '', issues: expect.arrayContaining([expect.stringContaining('图片不可用')]) });
      expect(list.list.find(row => row.id === 14)).not.toHaveProperty('price');
      for (const id of [20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35]) await expect(f.serviceFor(peer.db).read(id)).rejects.toThrow(/不存在|下架|异常/);
      const encoded = JSON.stringify(list);
      for (const secret of ['product_id','cost','settlePrice','PRIVATE','diskInfo','customForm','supplierName','supplier_name','relation_id']) expect(encoded).not.toContain(secret);
    }
    expect(await f.snapshot()).toEqual(before);
  }));
  it('retains a safe activity link when every effective SKU is sold out, retired or invalid instead of granting redemption or substituting the base product', async () => profiles(async (app, admin) => {
    await f.db.update(storeProductAttrValue).set({ stock: 0 }).where(eq(storeProductAttrValue.id, 90));
    await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.id, 91));
    await f.db.insert(storeProductAttrValue).values({ id: 92, productId: 9, type: 4, unique: 'wrong009', suk: '未配对规格', stock: 20, quota: 10, integral: 1, price: '1.00' });
    const before = await f.snapshot();
    for (const peer of [app, admin]) {
      const detail = await f.serviceFor(peer.db).read(9), target = (await f.catalogFor(peer.db).targets(query())).list.find(row => row.id === 9)!;
      expect(detail.saleStock).toBe(0); expect(detail.skus.every(sku => !sku.purchasable && sku.stock === 0)).toBe(true);
      expect(target).toMatchObject({ id: 9, selectable: true, url: '/pages/activity/goods_details/index?id=9&type=4' });
      const soldOut = (await f.catalogFor(peer.db).targets(query())).list.find(row => row.id === 13)!;
      expect(soldOut).toMatchObject({ selectable: true, issues: expect.arrayContaining([expect.stringContaining('为0')]) });
      expect(target.url).not.toContain('id=70');
    }
    expect(await f.snapshot()).toEqual(before);
  }));
  it('pins count, visible owner and image projection to the same real RR snapshot across an independently committed catalog change', async () => profiles(async (_app, admin) => {
    let changed = false;
    const observed = observeIntegralReadDb(admin.db, async (_tx, statement) => {
      if (!changed && statement.includes('SELECT count(*)::integer AS count FROM (') && statement.includes('public.store_integral a')) {
        changed = true; await f.exec('UPDATE public.system_store SET is_show=0 WHERE id=77');
        await f.db.insert(storeIntegral).values({ id: 99, productId: 70, storeName: '并发发布积分', image: '/api/assets/41' });
        await f.db.insert(storeProductDescription).values({ productId: 13, type: 4, description: 'x'.repeat(200001) });
      }
    });
    const pinned = await new AdminFabLinkCatalogService(createContainerFromDb(observed), f.env).targets(query());
    expect(changed).toBe(true); expect(pinned.count).toBe(8); expect(pinned.list.map(row => row.id)).not.toContain(99);
    expect(pinned.list.find(row => row.id === 10)).toMatchObject({ selectable: true, image_preview: expect.stringMatching(/^\/api\/assets\/41\?/) });
    expect(pinned.list.find(row => row.id === 13)).toMatchObject({ selectable: true });
    const fresh = await f.catalogFor(admin.db).targets(query());
    expect(fresh.count).toBe(8); expect(fresh.list.map(row => row.id)).toContain(99); expect(fresh.list.map(row => row.id)).not.toContain(10);
    expect(fresh.list.find(row => row.id === 13)).toMatchObject({ selectable: false, issues: expect.arrayContaining([expect.stringContaining('暂不可选择')]) });
  }));
  it('disables only product-local unreadable details in one batch and propagates the whole-request body budget without fabricating a successful catalog', async () => profiles(async (_app, admin) => {
    await f.db.insert(storeIntegral).values([50,51,52,53].map(id => ({ id, productId: 70, storeName: `超限资料${id}`, image: '/api/assets/41' })));
    await f.db.insert(storeProductAttrValue).values(Array.from({ length: 501 }, (_, index) => ({ id: 9000 + index, productId: 50, type: 4,
      unique: `c${String(index).padStart(7, '0')}`, suk: `容量规格${index}`, stock: 1, quota: 1, price: '1.00', integral: 1 })));
    await f.db.insert(storeProductAttr).values(Array.from({ length: 11 }, (_, index) => ({ id: 9000 + index, productId: 51, type: 4, attrName: `维度${index}`, attrValues: '一种' })));
    await f.db.insert(storeProductDescription).values([{ productId: 52, type: 4, description: 'x'.repeat(200001) },
      { productId: 53, type: 4, description: Array.from({ length: 1001 }, (_, index) => `<img src="/api/assets/${7000 + index}">`).join('') }]);
    const before = await f.snapshot(), commands: string[] = [];
    const observed = observeIntegralReadDb(admin.db, async (_tx, command) => { commands.push(command); });
    const result = await new AdminFabLinkCatalogService(createContainerFromDb(observed), f.env).targets(query());
    expect(result.count).toBe(12);
    for (const id of [50,51,52,53]) {
      expect(result.list.find(row => row.id === id)).toMatchObject({ id, selectable: false, url: `/pages/activity/goods_details/index?id=${id}&type=4`,
        issues: expect.arrayContaining([expect.stringContaining('暂不可选择')]) });
      await expect(f.serviceFor(admin.db).read(id)).rejects.toBeInstanceOf(ValidateException);
    }
    expect(result.list.find(row => row.id === 13)).toMatchObject({ selectable: true });
    // The chooser only reads the shared bounded projection, not each full
    // detail's dimensions, config, form, gallery and owner queries per row.
    expect(commands.filter(command => /from\s+(?:public\.)?"?store_integral"?/i.test(command))).toHaveLength(2);
    expect(commands.filter(command => /store_product_attr|store_product_description/i.test(command)).length).toBeLessThanOrEqual(4);
    expect(await f.snapshot()).toEqual(before);
    await f.db.insert(storeIntegral).values(Array.from({ length: 12 }, (_, index) => ({ id: 100 + index, productId: 70, storeName: `合计超预算${index}` })));
    await f.db.insert(storeProductDescription).values(Array.from({ length: 12 }, (_, index) => ({ productId: 100 + index, type: 4, description: 'x'.repeat(190000) })));
    const budgetBefore = await f.snapshot();
    await expect(f.catalogFor(admin.db).targets(query())).rejects.toBeInstanceOf(ValidateException);
    expect(await f.snapshot()).toEqual(budgetBefore);
    await f.db.insert(systemConfig).values(Array.from({ length: 1001 }, (_, index) => ({ id: 2000 + index, menuName: 'site_name', value: '"过量配置"' })));
    const configBefore = await f.snapshot();
    await expect(f.catalogFor(admin.db).targets(query())).rejects.toThrow('积分详情展示配置超过完整容量');
    expect(await f.snapshot()).toEqual(configBefore);
  }));
  it('propagates a real owner-table timeout and missing runtime SELECT rather than returning a successful empty or disabled catalog', async () => profiles(async (_app, admin) => {
    const codes = (error: unknown) => { const result: string[] = []; let reason = error; for (let n = 0; n < 8 && reason && typeof reason === 'object'; n++) { if ('code' in reason) result.push(String(reason.code)); reason = 'cause' in reason ? reason.cause : null; } return result; };
    await f.withPeer(async writer => {
      await writer.exec('BEGIN'); await writer.exec('LOCK TABLE public.system_store IN ACCESS EXCLUSIVE MODE');
      const read = f.catalogFor(admin.db).targets(query()).then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
      try {
        await waitForFinanceBlock(f.db, admin.pid, writer.pid);
        const result = await read; expect(result.ok).toBe(false); if (!result.ok) expect(codes(result.error)).toContain('55P03');
      } finally { await writer.exec('ROLLBACK'); }
    });
    await f.exec(`REVOKE SELECT ON public.store_integral FROM "${admin.role}"`);
    const denied = await f.catalogFor(admin.db).targets(query()).then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
    expect(denied.ok).toBe(false); if (!denied.ok) expect(codes(denied.error)).toContain('42501');
  }));
});
