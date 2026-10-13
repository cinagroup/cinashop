import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { storeBrand, storeProduct, storeProductLabel, storePromotions, storePromotionsAuxiliary,
  systemAttachment, systemSupplier } from '@/models/schema';
import { PublicCatalogService } from '@/services/product/PublicCatalogService';
import { financePostgres } from './helpers/financePostgres';

const appKey = 'local-label-public-badge-fixture';
describe('public product label badge projection', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let catalog: PublicCatalogService;
  beforeAll(async () => {
    fixture = await financePostgres([storeBrand, storeProduct, storeProductLabel, storePromotions,
      storePromotionsAuxiliary, systemAttachment, systemSupplier]);
    const container = createContainerFromDb(fixture.db);
    vi.spyOn(container.storeProductDao, 'getIdsByWhere').mockResolvedValue([1]);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Public labels must not fetch pictures'));
    catalog = new PublicCatalogService(container, { APP_KEY: appKey } as Env);
    await fixture.db.insert(storeProduct).values({ id: 1, storeLabelId: '10,11,12', storeName: '标签公开样本' });
    await fixture.db.insert(storeProductLabel).values([
      { id: 10, type: 0, relationId: 0, labelCate: 1, labelName: '图片标签', styleType: 2, icon: '/api/assets/100', status: 1, isShow: 1 },
      { id: 11, type: 0, relationId: 0, labelCate: 1, labelName: '他人素材', styleType: 2, icon: '/api/assets/101', status: 1, isShow: 1 },
      { id: 12, type: 0, relationId: 0, labelCate: 1, labelName: '已停用', styleType: 2, icon: '/api/assets/100', status: 0, isShow: 1 },
    ]);
    await fixture.db.insert(systemAttachment).values([
      { attId: 100, type: 1, relationId: 0, moduleType: 1, imageType: 8, fileType: 1, attType: 'image/png', name: 'attachments/admin/1/label.png', attDir: '/api/assets/100' },
      { attId: 101, type: 4, relationId: 7, moduleType: 1, imageType: 8, fileType: 1, attType: 'image/png', name: 'attachments/supplier/7/label.png', attDir: '/api/assets/101' },
    ]);
  }, 30_000);
  afterAll(async () => { vi.restoreAllMocks(); await fixture?.close(); }, 30_000);
  function checkLabels(labels: unknown) {
    const rows = labels as Array<Record<string, unknown>>;
    expect(rows.map(row => row.id)).toEqual([10, 11]);
    const url = new URL(String(rows[0].icon), 'https://local.invalid');
    expect(url.pathname).toBe('/api/assets/100');
    const expires = Number(url.searchParams.get('expires'));
    expect(expires).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(url.searchParams.get('signature')).toBe(createHmac('sha256', appKey).update(`GET\n/api/assets/100\n${expires}`).digest('base64url'));
    expect(rows[1].icon).toBe('');
    for (const row of rows) { expect(row).not.toHaveProperty('type'); expect(row).not.toHaveProperty('relationId'); }
    expect(fetch).not.toHaveBeenCalled();
  }
  it('renders owned images for real catalog decoration and hides foreign pictures', async () => {
    const [product] = await catalog.decorateProducts([{ id: 1, store_label_id: '10,11,12' }]);
    checkLabels(product.store_label);
    expect((await fixture.db.select().from(storeProductLabel).where(eq(storeProductLabel.id, 10)))[0].icon).toBe('/api/assets/100');
  });
  it('applies the same media authority to actual product search-filter output', async () => {
    const result = await catalog.searchFilter({});
    checkLabels(result.store_label);
    expect((await fixture.db.select().from(storeProductLabel).where(eq(storeProductLabel.id, 11)))[0].icon).toBe('/api/assets/101');
  });
});
