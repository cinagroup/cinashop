import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import type { Env } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { storeActivity, storeSeckill, storeSeckillTime, systemAttachment, systemSupplier } from '../src/models/schema';
import { ActivityService } from '../src/services/activity/ActivityService';
import { financePostgres } from './helpers/financePostgres';

const appKey = 'local-seckill-product-media-key';
describe('public seckill list issues owned image signatures and preserves stored references', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  beforeAll(async () => { f = await financePostgres([storeActivity, storeSeckill, storeSeckillTime, systemAttachment, systemSupplier]); }, 30_000);
  afterAll(async () => { vi.restoreAllMocks(); await f?.close(); });
  beforeEach(async () => {
    vi.restoreAllMocks(); await f.reset();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Image URLs must never be fetched by a list request'));
    await f.db.insert(storeSeckillTime).values({ id: 101, startTime: '00:00', endTime: '24:00', status: 1 });
    await f.db.insert(systemSupplier).values([7,8].map(id=>({id,supplierName:`本机供应商${id}`,isShow:1,isDel:0})));
    await f.db.insert(systemAttachment).values([
      { attId: 61, type: 1, relationId: 0, moduleType: 1 },
      { attId: 62, type: 4, relationId: 7, moduleType: 1 },
      { attId: 63, type: 4, relationId: 8, moduleType: 1 },
      { attId: 64, type: 3, relationId: 11, moduleType: 3 },
      { attId: 65, type: 1, relationId: 2, moduleType: 2 },
      { attId: 66, type: 1, relationId: 0, moduleType: 1, attType: 'video/mp4', fileType: 2 },
      { attId: 67, type: 1, relationId: 0, moduleType: 1, attDir: '/api/assets/999' },
      { attId: 68, type: 1, relationId: 0, moduleType: 1, attType: 'application/pdf' },
      { attId: 69, type: 1, relationId: 0, moduleType: 1, name: 'attachments/admin/0/incorrect-owner.png' },
    ].map(row => ({ imageType: 8, fileType: 1, attType: 'image/png', attDir: `/api/assets/${row.attId}`,
      name: row.type===4 ? `attachments/supplier/${row.relationId}/media-test-${row.attId}.png` : `attachments/admin/1/media-test-${row.attId}.png`, ...row })));
    await f.db.insert(storeSeckill).values({ id: 20, activityId: 0, timeId: '101', productId: 70, storeName: '媒体合同样本',
      type: 1, relationId: 0, image: '/api/assets/61', status: 1, isShow: 1, isDel: 0, price: '6.25', quota: 8, quotaShow: 10 });
  });
  const service = (key: string | null = appKey) => new ActivityService(createContainerFromDb(f.db), { APP_KEY: key ?? undefined } as Env);
  async function picture() { const list = await service().seckillList('101'); expect(fetch).not.toHaveBeenCalled(); expect(list).toHaveLength(1); return list[0].image; }
  function signed(value: string, id: number) {
    const url = new URL(value, 'https://local.invalid'); expect(url.pathname).toBe(`/api/assets/${id}`);
    const expires = Number(url.searchParams.get('expires'));
    expect(expires).toBeGreaterThan(Math.floor(Date.now()/1000)); expect(expires).toBeLessThanOrEqual(Math.floor(Date.now()/1000)+900);
    expect(url.searchParams.get('signature')).toBe(createHmac('sha256', appKey).update(`GET\n/api/assets/${id}\n${expires}`).digest('base64url'));
  }
  it('signs platform images at response time without writing signatures or changing the list contract', async () => {
    const before = await f.db.select().from(storeSeckill), list = await service().seckillList('101');
    signed(list[0].image,61); expect(list[0]).toMatchObject({ id: 20, product_id: 70, title: '媒体合同样本', price: 6.25, quota: 8, quota_show: 10, stock: 8 });
    expect(await f.db.select().from(storeSeckill)).toEqual(before); expect(fetch).not.toHaveBeenCalled();
  });
  it('accepts an owned supplier image and shared platform image but never another supplier image', async () => {
    await f.db.update(storeSeckill).set({ type: 2, relationId: 7, image: '/api/assets/62' }).where(eq(storeSeckill.id,20)); signed(await picture(),62);
    await f.db.update(storeSeckill).set({ image: '/api/assets/61' }).where(eq(storeSeckill.id,20)); signed(await picture(),61);
    await f.db.update(storeSeckill).set({ image: '/api/assets/63' }).where(eq(storeSeckill.id,20)); expect(await picture()).toBe('');
    await f.db.update(storeSeckill).set({ image: '/api/assets/62' }).where(eq(storeSeckill.id,20));
    await f.db.update(systemSupplier).set({ isShow:0 }).where(eq(systemSupplier.id,7));expect(await picture()).toBe('');
  });
  it('does not mint public links for user, kefu, video, missing or mismatched attachment records', async () => {
    for (const id of [62,64,65,66,67,68,69,999]) {
      await f.db.update(storeSeckill).set({ image: `/api/assets/${id}` }).where(eq(storeSeckill.id,20)); expect(await picture(),String(id)).toBe('');
    }
  });
  it('refreshes copied expired signatures while keeping the database reference unchanged', async () => {
    const stale='/api/assets/61?expires=1&signature=old'; await f.db.update(storeSeckill).set({ image:stale }).where(eq(storeSeckill.id,20));
    signed(await picture(),61); expect((await f.db.select().from(storeSeckill))[0].image).toBe(stale);
  });
  it('keeps safe legacy URLs and rejects executable, protocol-relative and backslash historical values', async () => {
    for(const image of ['https://example.invalid/product.png','/images/product.png']) {
      await f.db.update(storeSeckill).set({ image }).where(eq(storeSeckill.id,20));expect(await picture()).toBe(image);
    }
    for(const image of ['javascript:alert(1)','//example.invalid/product.png','/images\\bad.png','data:text/html,<script>']) {
      await f.db.update(storeSeckill).set({ image }).where(eq(storeSeckill.id,20));expect(await picture()).toBe('');
    }
  });
  it('does not require an image signing secret for empty lists or non-private legacy URLs', async () => {
    await f.db.update(storeSeckill).set({ image:'/images/product.png' }).where(eq(storeSeckill.id,20));
    expect((await service(null).seckillList('101'))[0].image).toBe('/images/product.png');
    await f.db.update(storeSeckill).set({ isDel:1 }).where(eq(storeSeckill.id,20));expect(await service(null).seckillList('101')).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
