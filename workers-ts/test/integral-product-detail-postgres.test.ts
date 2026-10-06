import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { storeIntegral, storeProduct, storeProductAttr, storeProductAttrValue, storeProductDescription, systemAttachment, systemStore, systemSupplier, systemDise, systemForm, systemConfig } from '../src/models/schema';
import { IntegralProductReadService } from '../src/services/activity/IntegralProductReadService';
import { IntegralProductUnavailableException } from '../src/services/activity/IntegralProductDetailData';
import { integralPublicCandidateSql } from '../src/services/activity/IntegralPublicCatalogPolicy';
import { readIntegralCatalogReadability } from '../src/services/activity/IntegralCatalogReadability';
import { integralProductReadFixture, integralReadBindings, observeIntegralReadDb } from './helpers/integralProductReadFixture';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('integral detail genuine PostgreSQL snapshot and SELECT authority', () => {
  let f: Awaited<ReturnType<typeof integralProductReadFixture>>;
  let guard: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => { f = await integralProductReadFixture(); guard = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Integral detail must not fetch provider or images')); }, 30000);
  afterEach(async () => { try { if (guard) expect(guard).not.toHaveBeenCalled(); } finally { guard?.mockRestore(); await f?.close(); } }, 30000);
  const app = async <T>(run: (peer: Parameters<typeof f.installSelectSlice>[0]) => Promise<T>) => f.withRuntimeRole(async peer => { await f.installSelectSlice(peer, 'app'); return run(peer); });
  const readability = (peer: Parameters<typeof f.installSelectSlice>[0], items = [{ id: 9, productId: 70 }]) => withTx(createContainerFromDb(peer.db), async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); return readIntegralCatalogReadability(tx, items);
  });

  it('returns all legacy display content with a safe explicit DTO under genuine app and Admin SELECT LOGINs', async () => {
    const before = await f.snapshot();
    for (const kind of ['app', 'admin'] as const) await f.withRuntimeRole(async peer => {
      await f.installSelectSlice(peer, kind);
      expect((await peer.exec('SELECT current_user,session_user'))[0]).toEqual({ current_user: peer.role, session_user: peer.role });
      await expect(peer.exec('CREATE TABLE public.integral_forbidden(id integer)')).rejects.toMatchObject({ code: '42501' });
      await expect(peer.exec('UPDATE store_integral SET stock=1 WHERE id=9')).rejects.toMatchObject({ code: '42501' });
      const result = await f.serviceFor(peer.db).read(9);
      expect(result.storeInfo).toMatchObject({ id: 9, productId: 70, storeName: '积分商品', unitName: '件', productType: 0, sales: 2, onceNum: 3, num: 8, systemFormId: 3,
        deliveryType: ['1', '2'], price: '1.00', otPrice: '35.00', integral: 5, brandName: '真实品牌', specs: [{ name: '材质', value: '纯棉', sort: 2 }] });
      expect(result.storeInfo.storeLabel[0]).toMatchObject({ id: 1, labelName: '棉质' }); expect(result.storeInfo.ensure[0]).toMatchObject({ id: 2, name: '正品保障', desc: '保障说明' });
      expect(result.storeInfo.image).toMatch(/^\/api\/assets\/41\?expires=\d+&signature=/); expect(result.storeInfo.images[1]).toBe('/legacy/gallery.png');
      expect(result.storeInfo.description).toContain('积分正文'); expect(result.storeInfo.description).toContain('/api/assets/41?expires=');
      expect(result.storeInfo.description).not.toMatch(/onerror|\/api\/assets\/43|WRONG TYPE BODY|BASE PRIVATE BODY/);
      expect(result.productAttr).toEqual([{ id: 1, name: '颜色', values: ['红', '蓝'] }]);
      expect(result.skus.map(row => [row.unique, row.stock, row.price, row.integral])).toEqual([['red00009', 8, '1.00', 5], ['blue0009', 6, '4.25', 10]]);
      expect(result.productValue['蓝']).toEqual(result.skus[1]); expect(result.saleStock).toBe(1);
      expect(result).toMatchObject({ siteName: '积分商城', shareQrcode: 1, productPosterTitle: '兑换分享' });
      expect(JSON.stringify(result)).not.toMatch(/diskInfo|settlePrice|customForm|cost|barCode|PRIVATE/);
    });
    expect(await f.snapshot()).toEqual(before);
  });
  it('includes base product stock in effective availability instead of displaying an impossible purchase', async () => {
    await f.db.update(storeProduct).set({ stock: 2 }).where(eq(storeProduct.id, 70));
    await app(async peer => expect((await f.serviceFor(peer.db).read(9)).skus.map(row => row.stock)).toEqual([2, 2]));
  });
  it('keeps a legitimate published sold-out activity readable and included in the shared catalogue policy', async () => {
    await f.db.update(storeIntegral).set({ quota: 0 }).where(eq(storeIntegral.id, 9));
    await app(async peer => {
      const result = await f.serviceFor(peer.db).read(9); expect(result.saleStock).toBe(0); expect(result.skus.every(row => !row.purchasable && row.stock === 0 && !row.issues.length)).toBe(true);
      const rows = await peer.db.execute(sql`SELECT a.id FROM store_integral a JOIN store_product p ON p.id=a.product_id WHERE ${integralPublicCandidateSql()}`); expect(rows.map(row => row.id)).toEqual([9]);
    });
  });
  it('diagnoses duplicate activity combinations without overwriting productValue or authorizing either identity', async () => {
    await f.db.insert(storeProductAttrValue).values({ id: 95, productId: 9, type: 4, unique: 'extra009', suk: '蓝', stock: 5, quota: 5, price: '5.00', integral: 20 });
    await app(async peer => { const result = await f.serviceFor(peer.db).read(9), blue = result.skus.filter(row => row.suk === '蓝');
      expect(blue).toHaveLength(2); expect(blue.every(row => !row.purchasable && row.stock === 0 && row.issues.includes('activity_sku_ambiguous'))).toBe(true); expect(Object.hasOwn(result.productValue, '蓝')).toBe(false); expect(result.productValue['红'].purchasable).toBe(true);
    });
  });
  it('diagnoses retired base pairs while preserving the other real available SKU', async () => {
    await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.id, 81));
    await app(async peer => { const result = await f.serviceFor(peer.db).read(9); expect(result.skus[1]).toMatchObject({ stock: 0, purchasable: false }); expect(result.skus[1].issues).toContain('base_sku_retired'); expect(result.skus[0].purchasable).toBe(true); });
  });
  it('never synthesizes an ordinary exchange SKU after the activity catalogue is retired', async () => {
    await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(and(eq(storeProductAttrValue.productId, 9), eq(storeProductAttrValue.type, 4)));
    await app(async peer => { const result = await f.serviceFor(peer.db).read(9); expect(result.skus).toEqual([]); expect(result.saleStock).toBe(0); expect(result.productValue).toEqual({}); expect(result.issues).toContain('activity_sku_retired'); });
  });
  it('projects malformed numeric history as an explicit disabled SKU with no private payload', async () => {
    await f.db.update(storeProductAttrValue).set({ price: 'NaN', integral: -1 }).where(eq(storeProductAttrValue.id, 91));
    await app(async peer => { const before = await f.snapshot(), result = await f.serviceFor(peer.db).read(9); expect(result.skus[1]).toMatchObject({ price: '0.00', integral: 0, stock: 0, purchasable: false });
      expect(result.skus[1].issues).toEqual(expect.arrayContaining(['sku_money_invalid', 'sku_integral_invalid'])); expect(await f.snapshot()).toEqual(before);
      await f.db.update(storeProductAttrValue).set({ price: '9999999999.99', otPrice: '9999999999.99', integral: 0 }).where(eq(storeProductAttrValue.id, 91));
      const boundary = (await f.serviceFor(peer.db).read(9)).skus[1]; expect(boundary).toMatchObject({ price: '9999999999.99', otPrice: '9999999999.99', integral: 0, purchasable: true });
      await f.db.update(storeProductAttrValue).set({ price: '0.00', integral: 10 }).where(eq(storeProductAttrValue.id, 91));
      expect((await f.serviceFor(peer.db).read(9)).skus[1]).toMatchObject({ price: '0.00', integral: 10, purchasable: true });
    });
  });
  it('refuses owner drift and excludes it from exactly the same catalogue SQL', async () => {
    await f.db.update(storeIntegral).set({ type: 2, relationId: 88 }).where(eq(storeIntegral.id, 9));
    await app(async peer => { await expect(f.serviceFor(peer.db).read(9)).rejects.toMatchObject({ issues: ['activity_owner_mismatch'] });
      expect((await peer.db.execute(sql`SELECT a.id FROM store_integral a JOIN store_product p ON p.id=a.product_id WHERE ${integralPublicCandidateSql()}`))).toHaveLength(0); });
  });
  it.each([1, 2] as const)('preserves real type-%s replica identity, validates its platform parent and existing media library', async type => {
    await f.db.insert(storeProduct).values({ id: 72, pid: 70, type, relationId: type === 1 ? 77 : 88, productType: 0, storeName: '真实副本', stock: 20, isShow: 1, isDel: 0, isVerify: 1 });
    await f.db.update(storeProductAttrValue).set({ productId: 72 }).where(and(eq(storeProductAttrValue.productId, 70), eq(storeProductAttrValue.type, 0)));
    await f.db.update(storeIntegral).set({ productId: 72, type, relationId: type === 1 ? 77 : 88, image: `/api/assets/${type === 1 ? 41 : 42}` }).where(eq(storeIntegral.id, 9));
    await app(async peer => {
      const result = await f.serviceFor(peer.db).read(9); expect(result.storeInfo.productId).toBe(72); expect(result.storeInfo.image).toContain(`/api/assets/${type === 1 ? 41 : 42}?`);
      expect((await peer.db.execute(sql`SELECT a.id FROM store_integral a JOIN store_product p ON p.id=a.product_id WHERE ${integralPublicCandidateSql()}`))).toHaveLength(1);
      if (type === 1) await f.db.update(systemStore).set({ isStore: 0 }).where(eq(systemStore.id, 77));
      else await f.db.update(systemSupplier).set({ isShow: 0 }).where(eq(systemSupplier.id, 88));
      await expect(f.serviceFor(peer.db).read(9)).rejects.toBeInstanceOf(IntegralProductUnavailableException);
      expect((await peer.db.execute(sql`SELECT a.id FROM store_integral a JOIN store_product p ON p.id=a.product_id WHERE ${integralPublicCandidateSql()}`))).toHaveLength(0);
    });
  });
  it('honors detail DIY visibility, active form reference and absent type-4 description', async () => {
    await f.db.update(systemDise).set({ value: '{"showService":[3]}' }).where(eq(systemDise.id, 5));
    await f.db.update(systemForm).set({ status: 0 }).where(eq(systemForm.id, 3));
    await f.db.delete(storeProductDescription).where(and(eq(storeProductDescription.productId, 9), eq(storeProductDescription.type, 4)));
    await app(async peer => { const result = await f.serviceFor(peer.db).read(9); expect(result.storeInfo).toMatchObject({ description: '', ensure: [], specs: [], systemFormId: 3 }); expect(result.saleStock).toBe(0); expect(result.skus.every(row => row.issues.includes('form_unavailable'))).toBe(true); });
  });
  it('returns all 500 real pairs and refuses the 501st without silently truncating choices', async () => {
    await f.db.delete(storeProductAttrValue);
    const keys = Array.from({ length: 500 }, (_, index) => `s${index}`);
    await f.db.update(storeProductAttr).set({ attrValues: keys.join(',') }).where(eq(storeProductAttr.id, 1));
    await f.db.insert(storeProductAttrValue).values(keys.flatMap((suk, index) => [
      { id: 1000 + index, productId: 70, type: 0, unique: `b${String(index).padStart(7, '0')}`, suk, stock: 1 },
      { id: 2000 + index, productId: 9, type: 4, unique: `a${String(index).padStart(7, '0')}`, suk, stock: 1, quota: 1, price: '0.01', integral: 1 },
    ]));
    await app(async peer => { expect((await f.serviceFor(peer.db).read(9)).skus).toHaveLength(500); expect((await readability(peer)).get(9)).toEqual([]);
      await f.db.insert(storeProductAttrValue).values({ id: 2999, productId: 9, type: 4, unique: 'last0009', suk: 'overflow', stock: 1, quota: 1, price: '0.01', integral: 1 });
      const before = await f.snapshot(); await expect(f.serviceFor(peer.db).read(9)).rejects.toThrow('超过500'); expect((await readability(peer)).get(9)).toEqual(['activity_sku_capacity']); expect(await f.snapshot()).toEqual(before);
      await f.db.insert(storeProductAttrValue).values({ id: 1999, productId: 70, type: 0, unique: 'last0070', suk: 'overflow', stock: 1 });
      expect((await readability(peer)).get(9)).toEqual(['activity_sku_capacity', 'base_sku_capacity']);
    });
  });
  it('uses the same dimension, duplicate body, body length and canonical asset limits for catalogue readability', async () => {
    await app(async peer => {
      expect((await readability(peer)).get(9)).toEqual([]);
      await f.db.insert(storeProductAttr).values(Array.from({ length: 10 }, (_, index) => ({ id: 10 + index, productId: 9, type: 4, attrName: `维度${index}`, attrValues: '值' })));
      expect((await readability(peer)).get(9)).toEqual(['attribute_capacity']); await expect(f.serviceFor(peer.db).read(9)).rejects.toThrow('超过10');
      await f.db.delete(storeProductAttr).where(sql`${storeProductAttr.id}>=10`);
      await f.exec('DROP INDEX public.spd_product_type_unique');
      await f.db.insert(storeProductDescription).values({ productId: 9, type: 4, description: '导入的重复正文' });
      expect((await readability(peer)).get(9)).toEqual(['description_ambiguous']); await expect(f.serviceFor(peer.db).read(9)).rejects.toThrow('正文重复');
      await f.db.delete(storeProductDescription).where(and(eq(storeProductDescription.productId, 9), eq(storeProductDescription.type, 4)));
      await f.db.insert(storeProductDescription).values({ productId: 9, type: 4, description: 'a'.repeat(200001) });
      expect((await readability(peer)).get(9)).toEqual(['description_capacity']); await expect(f.serviceFor(peer.db).read(9)).rejects.toThrow('200000');
      const body = Array.from({ length: 1001 }, (_, index) => `<img src="/api/assets/${index + 1}">`).join('');
      await f.db.update(storeProductDescription).set({ description: body }).where(and(eq(storeProductDescription.productId, 9), eq(storeProductDescription.type, 4)));
      expect((await readability(peer)).get(9)).toEqual(['body_asset_capacity']); await expect(f.serviceFor(peer.db).read(9)).rejects.toThrow('素材超过1000');
    });
  });
  it('fails the whole catalogue request above its actual UTF8 2MiB body budget without partial results', async () => {
    await f.db.delete(storeProductDescription);
    const items = Array.from({ length: 11 }, (_, index) => ({ id: 9 + index, productId: 70 }));
    await f.db.insert(storeProductDescription).values(items.map(({ id }) => ({ productId: id, type: 4, description: 'a'.repeat(200000) })));
    await app(async peer => { const before = await f.snapshot(); expect((await readability(peer, items.slice(0, 10))).size).toBe(10);
      await expect(readability(peer, items)).rejects.toThrow('2MiB UTF8预算'); expect(await f.snapshot()).toEqual(before);
    });
  });
  it('propagates the same global configuration capacity error instead of turning a whole-system failure into disabled items', async () => {
    await f.db.insert(systemConfig).values(Array.from({ length: 997 }, (_, index) => ({ id: 100 + index, menuName: 'site_name', value: '"副本"' })));
    await app(async peer => { const before = await f.snapshot(); await expect(readability(peer)).rejects.toThrow('展示配置超过完整容量');
      await expect(f.serviceFor(peer.db).read(9)).rejects.toThrow('展示配置超过完整容量'); expect(await f.snapshot()).toEqual(before);
    });
  });
  it('uses one actual RR READ ONLY snapshot across owner, inventory, media and description changes', async () => {
    await app(async peer => {
      let observed = false;
      const db = observeIntegralReadDb(peer.db, async (_tx, command) => {
        if (observed || !command.includes('from "store_integral"')) return; observed = true;
        await f.withPeer(async writer => { expect(writer.pid).not.toBe(peer.pid);
          await writer.db.update(storeProduct).set({ stock: 2 }).where(eq(storeProduct.id, 70));
          await writer.db.update(systemAttachment).set({ attType: 'text/html' }).where(eq(systemAttachment.attId, 41));
          await writer.db.update(storeProductDescription).set({ description: '新的正文' }).where(and(eq(storeProductDescription.productId, 9), eq(storeProductDescription.type, 4)));
        });
      });
      const result = await new IntegralProductReadService(createContainerFromDb(db), integralReadBindings).read(9);
      expect(observed).toBe(true); expect(result.skus.map(row => row.stock)).toEqual([8, 6]); expect(result.storeInfo.image).toContain('/api/assets/41?'); expect(result.storeInfo.description).toContain('积分正文');
      const fresh = await f.serviceFor(peer.db).read(9); expect(fresh.skus.map(row => row.stock)).toEqual([2, 2]); expect(fresh.storeInfo.image).toBe(''); expect(fresh.storeInfo.description).toBe('新的正文');
    });
  });
  it('preserves stricter real transaction-local deadlines and READ ONLY isolation', async () => {
    await app(async peer => {
      await peer.exec("SET lock_timeout='400ms'; SET statement_timeout='2000ms'"); let settings: unknown;
      const db = observeIntegralReadDb(peer.db, async (tx, command) => { if (!command.includes("set_config('statement_timeout'")) return;
        settings = (await tx.execute(sql`SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement,
          current_setting('idle_in_transaction_session_timeout') AS idle, current_setting('transaction_read_only') AS readonly, current_setting('transaction_isolation') AS isolation`))[0];
      });
      await new IntegralProductReadService(createContainerFromDb(db), integralReadBindings).read(9);
      expect(settings).toEqual({ lock: '400ms', statement: '2s', idle: '5s', readonly: 'on', isolation: 'repeatable read' });
    });
  });
});
