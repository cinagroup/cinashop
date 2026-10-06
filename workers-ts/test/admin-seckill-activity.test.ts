import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { storeProduct, storeProductAttrValue, storeProductCategory, storeProductLabel, storeProductRelation, storeSeckill, storeSeckillTime, systemAttachment, systemSupplier } from '../src/models/schema';
import { requiredAdminPermission } from '../src/services/admin/AdminPermissionService';
import { activityEdit, seckillActivityFixture, seckillActivityInput } from './helpers/seckillActivityFixture';

vi.mock('../src/migrations/seckillTimeReferenceLock', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/migrations/seckillTimeReferenceLock')>();
  return process.env.TEST_FINANCE_POSTGRES_URL ? actual : { ...actual, acquireSeckillTimeReferenceLock: async () => undefined };
});
describe('dedicated seckill parent management: HTTP and actual SQL', () => {
  let f: Awaited<ReturnType<typeof seckillActivityFixture>>;
  beforeEach(async () => { f = await seckillActivityFixture(); }, 30000);
  afterEach(async () => { await f?.close(); }, 30000);
  const create = async (extra: Record<string, unknown> = {}) => {
    const result = (await f.request('', { method: 'POST', body: seckillActivityInput(extra) })).body;
    expect(result.status, result.msg).toBe(200); return result.data.id as number;
  };
  const detail = async (id: number) => {
    const result = (await f.request(`/${id}`)).body; expect(result.status, result.msg).toBe(200); return result.data;
  };
  it('separates parent read/manage from generic activity on both route families', async () => {
    for (const prefix of ['/adminapi', '/api/admin']) {
      expect(requiredAdminPermission('GET', `${prefix}/activity/seckill-activities/products/101`)).toBe('seckill_activity.view');
      expect(requiredAdminPermission('POST', `${prefix}/activity/seckill-activities`)).toBe('seckill_activity.manage');
      expect((await f.request('/options', { prefix, token: f.tokens.reader })).body.status).toBe(200);
      expect((await f.request('', { prefix, method: 'POST', token: f.tokens.reader, body: seckillActivityInput() })).body.status).not.toBe(200);
      expect((await f.request('', { prefix, token: f.tokens.other })).body.status).not.toBe(200);
    }
  });
  it('creates a parent and multiple product/SKU identities from server data atomically', async () => {
    const before = await f.snapshot(), id = await create({ products: [...seckillActivityInput().products,
      { child_id: null, product_id: 102, status: 0, skus: [{ id: null, base_unique: 'base0003', price: '4.00', quota_total: 12, enabled: true }] }] });
    const after = await f.snapshot(), row = await detail(id);
    expect(row.products).toHaveLength(2); expect(row.time_ids).toEqual([1, 2]); expect(row.valid).toBe(true);
    expect(row.image_preview).toMatch(/^\/api\/assets\/42\?expires=/);
    expect(row.products[0].skus[0]).toMatchObject({ cost: '2.00', ot_price: '20.00' });
    expect((await f.request('/products/101')).body.data.skus[0]).toMatchObject({ cost: '2.00', ot_price: '20.00' });
    expect(after.children.map(row => row.storeName)).toEqual(['基础101', '基础102']);
    expect(after.children.map(row => row.quota)).toEqual([30, 12]); expect(after.skus.filter(row => row.type === 1)).toHaveLength(3);
    expect(after.sources).toEqual(before.sources); expect(after.skus.filter(row => row.type === 0)).toEqual(before.skus);
    expect(after.logs).toHaveLength(1); expect(after.logs[0].action).toMatch(/^create;id=\d+;payload=[a-f0-9]{64}$/);
  });
  it('exact create replay returns the same identity without rewriting; changed replay refuses', async () => {
    const body = seckillActivityInput(), first = (await f.request('', { method: 'POST', body })).body;
    expect(first.status).toBe(200); const snapshot = await f.snapshot();
    expect((await f.request('', { method: 'POST', body })).body).toEqual(first); expect(await f.snapshot()).toEqual(snapshot);
    expect((await f.request('', { method: 'POST', body: { ...body, name: 'different' } })).body.status).not.toBe(200);
  });
  it('keeps child/SKU identity, sales and consumed quota through a total-quota edit', async () => {
    const id = await create(), initial = await detail(id), childId = initial.products[0].child_id, skuId = initial.products[0].skus[0].id;
    await f.db.update(storeSeckill).set({ quota: sql`quota-3`, stock: sql`stock-3`, sales: 3 }).where(eq(storeSeckill.id, childId));
    await f.db.update(storeProductAttrValue).set({ quota: sql`quota-3`, stock: sql`stock-3`, sales: 3 }).where(eq(storeProductAttrValue.id, skuId));
    const current = await detail(id), body = activityEdit(current); body.products[0].skus[0].quota_total = 25;
    expect((await f.request(`/${id}`, { method: 'PUT', body })).body.status).toBe(200);
    const after = await detail(id), snapshot = await f.snapshot();
    expect(after.products[0].child_id).toBe(childId); expect(after.products[0].skus.map((row: any) => [row.id, row.unique])).toEqual(initial.products[0].skus.map((row: any) => [row.id, row.unique]));
    expect(after.products[0].skus[0]).toMatchObject({ consumed: 3, remaining: 22, quota_total: 25 });
    expect(snapshot.children[0]).toMatchObject({ sales: 3, quota: 32, quotaShow: 35, stock: 32 });
  });
  it('refuses a total below consumed quota and source-stock overflow without partial writes', async () => {
    const id = await create(), initial = await detail(id), skuId = initial.products[0].skus[0].id;
    await f.db.update(storeSeckill).set({ quota: 25, stock: 25, sales: 5 });
    await f.db.update(storeProductAttrValue).set({ quota: 15, stock: 15, sales: 5 }).where(eq(storeProductAttrValue.id, skuId));
    for (const total of [4, 100]) {
      const body = activityEdit(await detail(id)); body.products[0].skus[0].quota_total = total;
      const before = await f.snapshot(); expect((await f.request(`/${id}`, { method: 'PUT', body })).body.status).not.toBe(200); expect(await f.snapshot()).toEqual(before);
    }
  });
  it('checks active aggregate source inventory on create and enable, and compares remaining after purchases', async () => {
    await f.db.update(storeProduct).set({ stock: 29 }).where(eq(storeProduct.id, 101));
    const initial = await f.snapshot();
    expect((await f.request('', { method: 'POST', body: seckillActivityInput() })).body.msg).toContain('基础商品库存');
    expect(await f.snapshot()).toEqual(initial);
    await f.db.update(storeProduct).set({ stock: 100 }).where(eq(storeProduct.id, 101));
    const id = await create(), child = (await detail(id)).products[0];
    await f.db.update(storeProduct).set({ stock: 29 }).where(eq(storeProduct.id, 101));
    const before = await f.snapshot();
    expect((await f.request(`/${id}/status`, { method: 'PUT', body: { revision: await f.revision(id), request_id: crypto.randomUUID(), status: 1 } })).body.msg).toContain('基础商品或规格库存');
    expect(await f.snapshot()).toEqual(before);
    await f.db.update(storeSeckill).set({ quota: 27, stock: 27, sales: 3 }).where(eq(storeSeckill.id, child.child_id));
    await f.db.update(storeProductAttrValue).set({ quota: 17, stock: 17, sales: 3 }).where(eq(storeProductAttrValue.id, child.skus[0].id));
    await f.db.update(storeProduct).set({ stock: 27 }).where(eq(storeProduct.id, 101));
    await f.db.update(storeProductAttrValue).set({ stock: 57 }).where(eq(storeProductAttrValue.id, 11));
    expect((await f.request(`/${id}`, { method: 'PUT', body: activityEdit(await detail(id)) })).body.status).toBe(200);
    expect((await detail(id)).products[0].skus[0]).toMatchObject({ consumed: 3, remaining: 17, quota_total: 20 });
    const retire = activityEdit(await detail(id)); retire.products[0].skus[0].enabled = false;
    await f.db.update(storeProduct).set({ stock: 10 }).where(eq(storeProduct.id, 101));
    expect((await f.request(`/${id}`, { method: 'PUT', body: retire })).body.status).toBe(200);
    expect((await f.request(`/${id}/status`, { method: 'PUT', body: { revision: await f.revision(id), request_id: crypto.randomUUID(), status: 1 } })).body.status).toBe(200);
    await f.db.update(storeProductAttrValue).set({ stock: 9 }).where(eq(storeProductAttrValue.id, 12));
    const perSkuBefore = await f.snapshot();
    expect((await f.request(`/${id}/status`, { method: 'PUT', body: { revision: await f.revision(id), request_id: crypto.randomUUID(), status: 1 } })).body.msg).toContain('基础商品或规格库存');
    expect(await f.snapshot()).toEqual(perSkuBefore);
  });
  it('retires deselected SKUs with evidence and never physically removes their refund identity', async () => {
    const id = await create(), initial = await detail(id), body = activityEdit(initial), oldId = body.products[0].skus[0].id;
    body.products[0].skus[0].enabled = false;
    expect((await f.request(`/${id}`, { method: 'PUT', body })).body.status).toBe(200);
    const snapshot = await f.snapshot(); expect(snapshot.skus.find(row => row.id === oldId)).toMatchObject({ isRetired: 1, quota: 20, quotaShow: 20 });
    expect(snapshot.retirements).toHaveLength(1); expect(snapshot.children[0]).toMatchObject({ quota: 30, quotaShow: 30 });
    const restore = activityEdit(await detail(id)); restore.products[0].skus[0].enabled = true;
    expect((await f.request(`/${id}`, { method: 'PUT', body: restore })).body.status).not.toBe(200);
  });
  it('closes damaged missing-source and product_id=0 legacy identities through explicit retirement', async () => {
    const id = await create(), initial = await detail(id), childId = initial.products[0].child_id;
    await f.db.update(storeSeckill).set({ productId: 0 }).where(eq(storeSeckill.id, childId));
    await f.db.update(storeProductAttrValue).set({ price: '0.00' }).where(eq(storeProductAttrValue.productId, childId));
    const damaged = await detail(id); expect(damaged.valid).toBe(false); expect(damaged.products[0].product_id).toBe(0);
    const body = activityEdit(damaged); body.products[0].status = 0; for (const sku of body.products[0].skus) sku.enabled = false;
    expect((await f.request(`/${id}`, { method: 'PUT', body })).body.status).toBe(200);
    expect((await f.snapshot()).skus.filter(row => row.type === 1).every(row => row.isRetired === 1)).toBe(true);
  });
  it('save respects individual child status, while standalone parent status cascades reopen and close', async () => {
    const id = await create(), body = activityEdit(await detail(id)); body.status = 0; body.products[0].status = 1;
    expect((await f.request(`/${id}`, { method: 'PUT', body })).body.status).toBe(200);
    expect((await f.snapshot()).children[0].status).toBe(1);
    for (const status of [0, 1]) {
      expect((await f.request(`/${id}/status`, { method: 'PUT', body: { revision: await f.revision(id), request_id: crypto.randomUUID(), status } })).body.status).toBe(200);
      expect((await f.snapshot()).parents[0].status).toBe(status); expect((await f.snapshot()).children[0].status).toBe(status);
    }
  });
  it('soft deletion atomically disables parent and children and leaves all SKU identities and counters', async () => {
    const id = await create(), before = await f.snapshot(), body = { revision: await f.revision(id), request_id: crypto.randomUUID() };
    expect((await f.request(`/${id}`, { method: 'DELETE', body })).body.status).toBe(200);
    const after = await f.snapshot(); expect(after.parents[0]).toMatchObject({ isDel: 1, status: 0 }); expect(after.children[0]).toMatchObject({ isDel: 1, status: 0 });
    expect(after.skus).toEqual(before.skus); expect((await f.request(`/${id}`, { method: 'DELETE', body })).body.status).toBe(200);
    expect((await f.request(`/${id}`)).body.status).not.toBe(200);
  });
  it('copy is a source read followed by new creation with independent parent, child and SKU IDs', async () => {
    const id = await create(), source = await detail(id), copied = activityEdit(source); delete copied.revision;
    for (const product of copied.products) { product.child_id = null; for (const sku of product.skus) sku.id = null; }
    const response = (await f.request('', { method: 'POST', body: copied })).body; expect(response.status).toBe(200);
    const clone = await detail(response.data.id); expect(clone.id).not.toBe(id); expect(clone.products[0].child_id).not.toBe(source.products[0].child_id);
    expect(clone.products[0].skus[0].id).not.toBe(source.products[0].skus[0].id); expect(clone.products[0].skus[0].consumed).toBe(0);
  });
  it('invalidates revisions for child/SKU or same-value parent rewrites, including xmin', async () => {
    const id = await create();
    for (const write of [async () => f.changeParent(id, { name: '多场秒杀' }), async () => f.db.update(storeSeckill).set({ status: 0 }),
      async () => f.db.update(storeProductAttrValue).set({ price: '5.00' }).where(eq(storeProductAttrValue.type, 1))]) {
      const revision = await f.revision(id); await write();
      expect((await f.request(`/${id}/status`, { method: 'PUT', body: { revision, request_id: crypto.randomUUID(), status: 0 } })).body.msg).toContain('已更新');
    }
  });
  it('validates real Shanghai days, dates order, limits, slot count, images and whitelisted bodies', async () => {
    for (const extra of [{ start_day: '2026-02-30' }, { start_day: '2026-1-01' }, { end_day: '2040-01-01' }, { num: 0 },
      { once_num: 11 }, { time_ids: [1, 1] }, { time_ids: [] }, { time_ids: Array.from({ length: 65 }, (_, n) => n + 1) },
      { image: '/x'.repeat(65) }, { image: 'http://bad.example/a' }, { status: '1' }, { applicable_type: 2 }, { name: 'bad\nname' }]) {
      expect((await f.request('', { method: 'POST', body: seckillActivityInput(extra) })).body.status).not.toBe(200);
    }
    expect((await f.snapshot()).parents).toHaveLength(0);
  });
  it('never signs private canonical media and rejects private image writes', async () => {
    await f.db.insert(systemAttachment).values({ attId: 99, type: 0, relationId: 4, moduleType: 1, fileType: 1, attDir: '/api/assets/99' });
    expect((await f.request('', { method: 'POST', body: seckillActivityInput({ image: '/api/assets/99' }) })).body.status).not.toBe(200);
    const id = await create(); await f.changeParent(id, { image: '/api/assets/99' });
    expect(await detail(id)).toMatchObject({ image: '', image_preview: '', valid: false });
  });
  it('preserves malformed legacy dates/status/raw fields and permits shutdown and archival', async () => {
    const id = await create(); await f.changeParent(id, { startDay: 0, endDay: 1, status: -1, timeId: 'bad', num: null });
    const row = await detail(id); expect(row).toMatchObject({ phase: 'invalid', status: 0, valid: false, start_day: '', raw: { status: -1, start_day: 0, time_id: 'bad' } });
    expect((await f.request(`/${id}/status`, { method: 'PUT', body: { revision: row.revision, request_id: crypto.randomUUID(), status: 1 } })).body.status).not.toBe(200);
    expect((await f.request(`/${id}/status`, { method: 'PUT', body: { revision: await f.revision(id), request_id: crypto.randomUUID(), status: 0 } })).body.status).toBe(200);
    expect((await f.request(`/${id}`, { method: 'DELETE', body: { revision: await f.revision(id), request_id: crypto.randomUUID() } })).body.status).toBe(200);
  });
  it('applies name/precise-ID/status/date phases before pagination and returns coherent count', async () => {
    const id = await create({ name: 'A% literal' }); await create({ name: 'B other', status: 0 });
    expect((await f.request('?keyword=%25&limit=1')).body.data).toMatchObject({ count: 1, list: [{ id }] });
    expect((await f.request(`?keyword=${id}&status=1&phase=active`)).body.data.count).toBe(1);
    expect((await f.request('?page=2&limit=1')).body.data).toMatchObject({ count: 2, page: 2, limit: 1 });
    expect((await f.request('?phase=invalid')).body.data.count).toBe(0);
    for (const query of ['limit=101', 'page=10002', 'keyword=x&keyword=y', 'phase=weird', 'type=seckill']) expect((await f.request(`?${query}`)).body.status).not.toBe(200);
  });
  it('options retain hidden slots and source-SKU catalog returns server-owned identifiers', async () => {
    expect((await f.request('/options')).body.data).toMatchObject({ times: [{ id: 1, status: 1 }, { id: 2, status: 0 }], max_slots: 64, max_total_skus: 5000 });
    expect((await f.request('/products/101')).body.data.skus.map((row: any) => row.base_unique)).toEqual(['base0001', 'base0002']);
    await f.db.update(storeProduct).set({ isPresaleProduct: 1 }).where(eq(storeProduct.id, 101));
    expect((await f.request('/products')).body.data.list.map((row: any) => row.product_id)).toEqual([102]);
  });
  it('damaged or missing chosen slots prevent an enabled save, with no partial parent/child writes', async () => {
    await f.db.update(storeSeckillTime).set({ endTime: 'bad' }).where(eq(storeSeckillTime.id, 2));
    const before = await f.snapshot(); expect((await f.request('', { method: 'POST', body: seckillActivityInput() })).body.status).not.toBe(200); expect(await f.snapshot()).toEqual(before);
    expect((await f.request('', { method: 'POST', body: seckillActivityInput({ time_ids: [999] }) })).body.status).not.toBe(200);
  });
  it('copies supplier-owned shipping, refund, settle/cost and SKU data only from real server sources', async () => {
    await f.db.insert(systemSupplier).values({ id: 7, adminId: 7, supplierName: 'owned supplier', isShow: 1, isDel: 0 });
    await f.db.update(storeProduct).set({ type: 2, relationId: 7, isSupportRefund: 0, postage: '3.00', freight: 2 }).where(eq(storeProduct.id, 101));
    await f.db.update(storeProductAttrValue).set({ settlePrice: '2.50', cost: '1.75', weight: '1.20' }).where(eq(storeProductAttrValue.type, 0));
    const before = await f.snapshot(), id = await create(), after = await f.snapshot();
    expect(after.children[0]).toMatchObject({ type: 2, relationId: 7, isSupportRefund: 0, freight: 2, postage: '3.00' });
    expect(after.skus.find(row => row.type === 1)).toMatchObject({ settlePrice: '2.50', cost: '1.75', weight: '1.20' });
    expect(after.sources).toEqual(before.sources); expect((await detail(id)).valid).toBe(true);
    const edit = activityEdit(await detail(id)); edit.name = '供应商改名';
    expect((await f.request(`/${id}`, { method: 'PUT', body: edit })).body.status).toBe(200);
    expect((await f.snapshot()).children[0].relationId).toBe(7);
  });
  it.each(['missing', 'hidden', 'deleted'] as const)('rejects %s suppliers while leaving invalid old source identity readable and closable', async kind => {
    if (kind !== 'missing') await f.db.insert(systemSupplier).values({ id: 7, adminId: 7, supplierName: 'inactive supplier', isShow: kind === 'hidden' ? 0 : 1, isDel: kind === 'deleted' ? 1 : 0 });
    const id = await create(); await f.db.update(storeProduct).set({ type: 2, relationId: 7 }).where(eq(storeProduct.id, 101));
    const row = await detail(id); expect(row.products[0].valid).toBe(false);
    expect((await f.request('', { method: 'POST', body: seckillActivityInput() })).body.status).not.toBe(200);
    expect((await f.request(`/${id}/status`, { method: 'PUT', body: { revision: await f.revision(id), request_id: crypto.randomUUID(), status: 1 } })).body.status).not.toBe(200);
    expect((await f.request(`/${id}/status`, { method: 'PUT', body: { revision: await f.revision(id), request_id: crypto.randomUUID(), status: 0 } })).body.status).toBe(200);
  });
  it('rejects forged cross-product child/SKU/base identities atomically', async () => {
    const id = await create(), row = await detail(id);
    for (const mutate of [(body: any) => { body.products[0].product_id = 102; }, (body: any) => { body.products[0].skus[0].base_unique = 'base0003'; },
      (body: any) => { body.products[0].skus[0].id = 11; }, (body: any) => { body.products[0].child_id = 999; }]) {
      const body = activityEdit(row); mutate(body); const before = await f.snapshot();
      expect((await f.request(`/${id}`, { method: 'PUT', body })).body.status).not.toBe(200); expect(await f.snapshot()).toEqual(before);
    }
  });
  it('detects inconsistent legacy aggregate accounts without blocking explicit shutdown', async () => {
    const id = await create(); await f.db.update(storeSeckill).set({ quotaShow: 31 });
    const body = activityEdit(await detail(id)), before = await f.snapshot();
    expect((await f.request(`/${id}`, { method: 'PUT', body })).body.status).not.toBe(200); expect(await f.snapshot()).toEqual(before);
    expect((await f.request(`/${id}/status`, { method: 'PUT', body: { revision: await f.revision(id), request_id: crypto.randomUUID(), status: 0 } })).body.status).toBe(200);
  });
  it('explicitly rejects over-cap legacy details while preserving revision-authorized hide/delete from list', async () => {
    const id = await create(); await f.db.insert(storeSeckill).values(Array.from({ length: 100 }, (_, n) => ({ activityId: id, productId: 1000 + n, status: 0 })));
    expect((await f.request(`/${id}`)).body.msg).toContain('超过100');
    const row = (await f.request()).body.data.list[0];
    expect((await f.request(`/${id}/status`, { method: 'PUT', body: { revision: row.revision, request_id: crypto.randomUUID(), status: 0 } })).body.status).toBe(200);
    const current = (await f.request()).body.data.list[0];
    expect((await f.request(`/${id}`, { method: 'DELETE', body: { revision: current.revision, request_id: crypto.randomUUID() } })).body.status).toBe(200);
    expect((await f.snapshot()).children.every(row => row.isDel === 1)).toBe(true);
  });
  it('keeps the PHP ended-date save boundary while allowing today, read, shutdown and explicit date repair', async () => {
    const oldDay = new Date(Date.now() + 28800000 - 2 * 86400000).toISOString().slice(0, 10);
    expect((await f.request('', { method: 'POST', body: seckillActivityInput({ start_day: oldDay, end_day: oldDay }) })).body.msg).toContain('结束日期已经过去');
    const id = await create(), epoch = Math.floor(new Date(`${oldDay}T00:00:00+08:00`).getTime() / 1000);
    await f.changeParent(id, { startDay: epoch, endDay: epoch });
    const ended = await detail(id); expect(ended.phase).toBe('ended');
    expect((await f.request(`/${id}`, { method: 'PUT', body: activityEdit(ended) })).body.msg).toContain('结束日期已经过去');
    expect((await f.request(`/${id}/status`, { method: 'PUT', body: { revision: await f.revision(id), request_id: crypto.randomUUID(), status: 0 } })).body.status).toBe(200);
    const repaired = activityEdit(await detail(id), { start_day: seckillActivityInput().start_day, end_day: seckillActivityInput().end_day });
    expect((await f.request(`/${id}`, { method: 'PUT', body: repaired })).body.status).toBe(200);
  });
  it('uses category descendants and exact type3 label relations without multiplying rows or counts', async () => {
    await f.db.insert(storeProductCategory).values([
      { id: 1, cateName: '根分类' }, { id: 2, pid: 1, cateName: '子分类', path: 'stale' },
      { id: 3, pid: 2, cateName: '隐藏后代', isShow: 0 }, { id: 11, cateName: '另一分类' },
      { id: 12, pid: 3, cateName: '隐藏祖先的显示子类' }, { id: 21, type: 2, relationId: 7, cateName: '供应商分类' }
    ]);
    await f.db.insert(storeProductLabel).values([{ id: 1, labelName: '停用但可筛选', status: 0, isShow: 0 }, { id: 2, labelName: '标签二' }, { id: 7, type: 2, relationId: 7, labelName: '私有标签' }]);
    await f.db.insert(storeProductRelation).values([
      { type: 1, productId: 101, relationId: 3 }, { type: 1, productId: 101, relationId: 3 }, { type: 1, productId: 102, relationId: 11 },
      { type: 3, productId: 101, relationId: 1 }, { type: 3, productId: 101, relationId: 1 }, { type: 4, productId: 102, relationId: 1 }
    ]);
    await f.db.update(storeProduct).set({ productType: 4, cateId: '3' }).where(eq(storeProduct.id, 101));
    const options = (await f.request('/options')).body.data;
    expect(options.categories.map((row: any) => row.id).sort((a: number, b: number) => a - b)).toEqual([1, 2, 11]);
    expect(options.labels.map((row: any) => row.id).sort((a: number, b: number) => a - b)).toEqual([1, 2]);
    for (const query of ['category_id=1', 'category_id=2', 'label_id=1', 'category_id=1&label_id=1']) {
      const result = (await f.request(`/products?${query}`)).body;
      expect(result.status, result.msg).toBe(200); expect(result.data.count).toBe(1); expect(result.data.list).toHaveLength(1);
      expect(result.data.list[0]).toMatchObject({ product_id: 101, product_type: 4, category_name: '隐藏后代' });
    }
    expect((await f.request('/products?category_id=11')).body.data.list[0].product_id).toBe(102);
    expect((await f.request('/products/101')).body.data).toMatchObject({ product_type: 4, category_name: '隐藏后代' });
    const id = await create(); expect((await detail(id)).products[0]).toMatchObject({ product_type: 4, category_name: '隐藏后代' });
  });
  it('rejects malformed, duplicate, unknown, hidden and out-of-scope filters and preserves the pagination cap', async () => {
    await f.db.insert(storeProductCategory).values([{ id: 1, cateName: '隐藏', isShow: 0 }, { id: 2, type: 2, relationId: 7, cateName: '私有' }]);
    await f.db.insert(storeProductLabel).values({ id: 2, type: 2, relationId: 7, labelName: '私有' });
    for (const query of ['category_id=-1', 'category_id=01', 'category_id=1,2', 'category_id=999', 'category_id=1', 'category_id=2',
      'label_id=999', 'label_id=2', 'category_id=0&category_id=0', 'label_id=0&label_id=', 'cate_id=0', 'page=668&limit=15'])
      expect((await f.request(`/products?${query}`)).body.status, query).not.toBe(200);
    for (const query of ['category_id=&label_id=', 'category_id=0&label_id=0']) expect((await f.request(`/products?${query}`)).body.data.count).toBe(2);
    expect((await f.request('?category_id=0')).body.status).not.toBe(200);
  });
  it.each(['cycle', 'orphan'] as const)('rejects %s category trees rather than truncating options or recursing forever', async kind => {
    await f.db.insert(storeProductCategory).values(kind === 'cycle' ? [{ id: 1, pid: 2 }, { id: 2, pid: 1 }] : [{ id: 1, pid: 999 }]);
    expect((await f.request('/options')).body.msg).toContain(kind === 'cycle' ? '循环' : '缺失父');
    expect((await f.request('/products?category_id=1')).body.status).not.toBe(200);
    expect((await f.request('/products')).body.status).toBe(200);
  });
  it.each(['category', 'label'] as const)('rejects over-cap %s options without returning a truncated picker', async kind => {
    if (kind === 'category') await f.db.insert(storeProductCategory).values(Array.from({ length: 5001 }, (_, i) => ({ id: i + 1, cateName: `分类${i + 1}` })));
    else await f.db.insert(storeProductLabel).values(Array.from({ length: 5001 }, (_, i) => ({ id: i + 1, labelName: `标签${i + 1}` })));
    const result = (await f.request('/options')).body;
    expect(result.status).not.toBe(200); expect(result.msg).toContain('超过5000'); expect(result.data).toBeNull();
  });
  it('returns SKU-specific stable media and refreshed previews using source and persisted child owners separately', async () => {
    await f.db.insert(systemSupplier).values([7, 8].map(id => ({ id, supplierName: `供应商${id}`, isShow: 1, isDel: 0 })));
    await f.db.insert(systemAttachment).values([
      { attId: 100, type: 1, relationId: 0, attDir: '/api/assets/100', imageType: 8, name: 'attachments/admin/1/sku.png', attType: 'image/png' },
      { attId: 101, type: 4, relationId: 7, attDir: '/api/assets/101', imageType: 8, name: 'attachments/supplier/7/sku.png', attType: '' },
      { attId: 102, type: 4, relationId: 8, attDir: '/api/assets/102', imageType: 8, name: 'attachments/supplier/8/sku.png', attType: 'image/png' },
      { attId: 103, type: 3, relationId: 11, moduleType: 3, attDir: '/api/assets/103', imageType: 8, name: 'attachments/user/11/sku.png', attType: 'image/png' },
      { attId: 104, type: 1, relationId: 0, attDir: '/api/assets/104', imageType: 8, name: 'attachments/admin/0/sku.png', attType: 'image/png' }
    ]);
    await f.db.update(storeProductAttrValue).set({ image: '/api/assets/100?expires=1&signature=old' }).where(eq(storeProductAttrValue.id, 11));
    expect((await f.request('/products/101')).body.data.skus[0]).toMatchObject({ image: '/api/assets/100', image_preview: expect.stringMatching(/^\/api\/assets\/100\?expires=/) });
    await f.db.update(storeProductAttrValue).set({ image: '/api/assets/104' }).where(eq(storeProductAttrValue.id, 11));
    expect((await f.request('/products/101')).body.data.skus[0]).toMatchObject({ image: '', image_preview: '' });
    await f.db.update(storeProduct).set({ type: 2, relationId: 7, image: '/api/assets/101' }).where(eq(storeProduct.id, 101));
    await f.db.update(storeProductAttrValue).set({ image: '/api/assets/101' }).where(eq(storeProductAttrValue.id, 11));
    await f.db.update(storeProductAttrValue).set({ image: '/api/assets/103' }).where(eq(storeProductAttrValue.id, 12));
    const source = (await f.request('/products/101')).body.data;
    expect(source.skus[0]).toMatchObject({ image: '/api/assets/101', image_preview: expect.stringMatching(/^\/api\/assets\/101\?expires=/) });
    expect(source.skus[1]).toMatchObject({ image: '', image_preview: '' });
    const id = await create(), before = await f.snapshot();
    expect((await detail(id)).products[0].skus[0].image).toBe('/api/assets/101');
    await f.db.update(storeProduct).set({ relationId: 8 }).where(eq(storeProduct.id, 101));
    await f.db.update(storeProductAttrValue).set({ image: '/api/assets/102' }).where(eq(storeProductAttrValue.id, 11));
    expect((await f.request('/products/101')).body.data.skus[0].image).toBe('/api/assets/102');
    expect((await detail(id)).products[0].skus[0].image).toBe('/api/assets/101');
    expect((await f.snapshot()).skus.filter(row => row.type === 1)).toEqual(before.skus.filter(row => row.type === 1));
    await f.db.update(systemSupplier).set({ isShow: 0 }).where(eq(systemSupplier.id, 7));
    expect((await detail(id)).products[0].skus[0]).toMatchObject({ image: '', image_preview: '' });
  });
});
