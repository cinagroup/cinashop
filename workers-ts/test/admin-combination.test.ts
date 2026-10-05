import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { storeCombination, storePink, storeProduct, storeProductAttr, storeProductAttrValue, storeProductCategory, storeProductLabel,
  storeProductRelation, systemAttachment, systemLog, systemSupplier } from '../src/models/schema';
import { combinationAdminFixture, combinationEdit, combinationInput } from './helpers/combinationAdminFixture';

describe('Dedicated complete Admin combination SQL configuration', () => {
  let f: Awaited<ReturnType<typeof combinationAdminFixture>>;
  const actor = { id: 2 };
  beforeEach(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden')); f = await combinationAdminFixture(); }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  const create = async (extra: Record<string, unknown> = {}) => (await f.service.mutate('create', 0, combinationInput(extra), actor)).id;
  const status = async (id: number, value: 0 | 1) => f.service.mutate('status', id, { status: value, revision: (await f.service.detail(id)).revision, request_id: crypto.randomUUID() }, actor);
  it('creates the entire source-derived type3 graph, rich content, gallery order, shipping and one atomic audit', async () => {
    const before = await f.snapshot(), id = await create(), after = await f.snapshot(), row = await f.service.detail(id);
    expect(row).toMatchObject({ title: '完整拼团', status: 1, valid: true, people: 3, virtual: 100, images: ['/images/first.png', '/images/second.png'],
      quota_total: 30, remaining: 30, consumed: 0, shipping: { freight: 1, temp_id: 0 } });
    expect(row.skus).toHaveLength(2); expect(row.skus[0]).toMatchObject({ cost: '2.00', ot_price: '10.00', remaining: 20, image: '/images/red.png' });
    expect(after.combinations[0]).toMatchObject({ image: '/images/first.png', sales: 0, isShow: 1, status: 1 });
    expect(after.attrs.filter(value => value.type === 3)).toHaveLength(1); expect(after.results.filter(value => value.type === 3)).toHaveLength(1);
    expect(after.descriptions.find(value => value.type === 3)?.description).toBe('<p>商品详情</p>');
    expect(after.sources).toEqual(before.sources); expect(after.skus.filter(value => value.type === 0)).toEqual(before.skus); expect(after.logs).toHaveLength(1);
  });
  it('replays an actor UUID exactly once and rejects reuse for altered payloads or operations', async () => {
    const input = combinationInput(), first = await f.service.mutate('create', 0, input, actor);
    expect(await f.service.mutate('create', 0, input, actor)).toEqual(first);
    await expect(f.service.mutate('create', 0, { ...input, title: 'changed' }, actor)).rejects.toThrow('其他');
    await expect(f.service.mutate('delete', first.id, { request_id: input.request_id, revision: (await f.service.detail(first.id)).revision }, actor)).rejects.toThrow('其他');
    expect((await f.snapshot()).logs).toHaveLength(1); expect((await f.snapshot()).combinations).toHaveLength(1);
  });
  it('retains purchased IDs/unique and sales while changing configured totals by net consumed', async () => {
    const id = await create(); await f.consume(id); const before = await f.service.detail(id), edit = combinationEdit(before);
    edit.skus[0].quota_total = 25; edit.skus[0].price = '0.00'; await f.service.mutate('update', id, edit, actor);
    const after = await f.service.detail(id); expect(after.skus[0]).toMatchObject({ id: before.skus[0].id, unique: before.skus[0].unique, consumed: 2, remaining: 23, quota_total: 25, price: '0.00' });
    expect(after).toMatchObject({ quota_total: 35, remaining: 33, stock: 33, sales: 2 });
  });
  it('checks remaining, rather than configured totals, against source stock after a purchase', async () => {
    const id = await create(); await f.consume(id);
    await f.db.update(storeProduct).set({ stock: 28 }).where(eq(storeProduct.id, 101));
    await f.db.update(storeProductAttrValue).set({ stock: 18 }).where(eq(storeProductAttrValue.id, 11));
    await f.service.mutate('update', id, combinationEdit(await f.service.detail(id)), actor);
    expect((await f.service.detail(id)).remaining).toBe(28);
  });
  it('rejects totals below consumed and refund-restoration overflows atomically', async () => {
    const id = await create(); await f.consume(id); const row = await f.service.detail(id);
    for (const total of [1, 2147483647]) { const body = combinationEdit(row); body.skus[0].quota_total = total; const before = await f.snapshot();
      await expect(f.service.mutate('update', id, body, actor)).rejects.toThrow(); expect(await f.snapshot()).toEqual(before); }
  });
  it('checks the sum of active remaining quotas against product stock independently of individual SKU stock', async () => {
    await f.db.update(storeProduct).set({ stock: 29 }).where(eq(storeProduct.id, 101)); const before = await f.snapshot();
    await expect(create()).rejects.toThrow('基础商品库存'); expect(await f.snapshot()).toEqual(before);
  });
  it('retirement keeps real refund identity and counters, logs it once and refuses implicit revival', async () => {
    const id = await create(); await f.consume(id); const row = await f.service.detail(id), edit = combinationEdit(row); edit.skus[0].enabled = false;
    await f.service.mutate('update', id, edit, actor); const stopped = await f.service.detail(id);
    expect(stopped.skus[0]).toMatchObject({ id: row.skus[0].id, unique: row.skus[0].unique, retired: true, enabled: false, consumed: 2, remaining: 18 });
    expect(stopped.remaining).toBe(28); expect((await f.snapshot()).retirements).toHaveLength(1);
    const reenable = combinationEdit(stopped); reenable.skus[0].enabled = true;
    await expect(f.service.mutate('update', id, reenable, actor)).rejects.toThrow('退役');
    await f.service.mutate('update', id, combinationEdit(stopped), actor); expect((await f.snapshot()).retirements).toHaveLength(1);
  });
  it('refuses omitted, forged and cross-product SKU identity and source replacement without partial writes', async () => {
    const id = await create(), row = await f.service.detail(id);
    for (const modify of [(body: ReturnType<typeof combinationEdit>) => { body.skus.pop(); },
      (body: ReturnType<typeof combinationEdit>) => { body.skus[0].id = 11; },
      (body: ReturnType<typeof combinationEdit>) => { body.skus[0].base_unique = 'base0003'; },
      (body: ReturnType<typeof combinationEdit>) => { body.product_id = 102; }]) {
      const body = combinationEdit(row); modify(body); const before = await f.snapshot(); await expect(f.service.mutate('update', id, body, actor)).rejects.toThrow(); expect(await f.snapshot()).toEqual(before);
    }
  });
  it('copies configured quota_show into independent activity/SKU identities with zero consumed and sales', async () => {
    const id = await create(); await f.consume(id); const original = await f.service.detail(id), copy = combinationEdit(original);
    const { revision: _revision, ...input } = copy;
    const cloneId = (await f.service.mutate('create', 0, { ...input, skus: input.skus.map(sku => ({ ...sku, id: null })) }, actor)).id, clone = await f.service.detail(cloneId);
    expect(cloneId).not.toBe(id); expect(clone).toMatchObject({ quota_total: 30, consumed: 0, remaining: 30, sales: 0 });
    expect(clone.skus[0].id).not.toBe(original.skus[0].id); expect(clone.skus[0].unique).not.toBe(original.skus[0].unique);
  });
  it.each(['status', 'delete', 'update'] as const)('%s preserves the legacy distinction between soft deletion and closing active pinks', async operation => {
    const id = await create(), tomorrow = new Date(Date.now() + 86400000);
    await f.db.insert(storePink).values([{ id: 1, combinationId: id, productId: 101, people: 3, status: 1, stopTime: tomorrow },
      { id: 2, combinationId: id, productId: 101, people: 3, status: 2, stopTime: tomorrow },
      { id: 3, combinationId: id, productId: 101, people: 3, status: 1, kId: 1, stopTime: tomorrow }]);
    const before = await f.snapshot(), detail = await f.service.detail(id);
    const body = operation === 'update' ? combinationEdit(detail, { status: 0 }) : { revision: detail.revision, request_id: crypto.randomUUID(), ...(operation === 'status' ? { status: 0 } : {}) };
    await f.service.mutate(operation, id, body, actor); const after = await f.snapshot();
    expect(after.combinations[0]).toMatchObject(operation === 'delete' ? { isDel: 1, status: before.combinations[0].status, isShow: before.combinations[0].isShow } : { status: 0, isShow: 0, isDel: 0 });
    if (operation === 'delete') expect(after.pinks).toEqual(before.pinks);
    else for (const group of after.pinks.filter(value => value.status === 1)) expect(group.stopTime!.getTime()).toBeLessThan(tomorrow.getTime());
    expect(after.pinks[1]).toEqual(before.pinks[1]); expect(after.skus).toEqual(operation === 'update' ? expect.any(Array) : before.skus);
    if (operation === 'delete') await expect(f.service.detail(id)).rejects.toThrow('不存在');
  });
  it('enable validates remaining quotas and current source availability rather than merely flipping flags', async () => {
    const id = await create(); await status(id, 0); await f.db.update(storeProduct).set({ stock: 29 }).where(eq(storeProduct.id, 101));
    await expect(status(id, 1)).rejects.toThrow('库存'); expect((await f.snapshot()).combinations[0]).toMatchObject({ status: 0, isShow: 0 });
    await f.db.update(storeProduct).set({ stock: 100 }).where(eq(storeProduct.id, 101)); await status(id, 1);
    expect((await f.snapshot()).combinations[0]).toMatchObject({ status: 1, isShow: 1 });
  });
  it('rejects expired creation and editing an already ended row while retaining detail/copy/shutdown/archive', async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    await expect(create({ start_time: yesterday, end_time: yesterday })).rejects.toThrow('当前时间');
    const id = await create(); await f.db.update(storeCombination).set({ startTime: new Date(yesterday), stopTime: new Date(yesterday) }).where(eq(storeCombination.id, id));
    const row = await f.service.detail(id); expect(row.phase).toBe('ended');
    await expect(f.service.mutate('update', id, combinationEdit(row, { end_time: combinationInput().end_time }), actor)).rejects.toThrow('已结束');
    await status(id, 0); await f.service.mutate('delete', id, { revision: (await f.service.detail(id)).revision, request_id: crypto.randomUUID() }, actor);
  });
  it('invalidates revisions on SKU/content changes and same-value row rewrites through xmin', async () => {
    const id = await create();
    for (const change of [() => f.db.update(storeCombination).set({ sort: 3 }).where(eq(storeCombination.id, id)),
      () => f.db.update(storeProductAttrValue).set({ price: '5.00' }).where(eq(storeProductAttrValue.type, 3))]) {
      const revision = (await f.service.detail(id)).revision; await change();
      await expect(f.service.mutate('status', id, { revision, request_id: crypto.randomUUID(), status: 0 }, actor)).rejects.toThrow('已更新');
    }
  });
  it('rolls back graph creation or editing if the atomic audit insert fails', async () => {
    await f.exec("CREATE FUNCTION reject_combination_audit() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''fixture audit failure''; END'; CREATE TRIGGER reject_combination_audit BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION reject_combination_audit()");
    const before = await f.snapshot(); await expect(create()).rejects.toThrow(); expect(await f.snapshot()).toEqual(before);
  });
  it('bounds and whitelists all configuration, exact UTC times, quotas, money and shipping fields', async () => {
    for (const extra of [{ title: 'x'.repeat(257) }, { info: 'x'.repeat(256) }, { unit_name: 'x'.repeat(33) }, { start_time: '2026-02-30T00:00:00Z' },
      { start_time: '2026-09-27T08:00:00+08:00' }, { people: 1 }, { people: 501 }, { num: 0 }, { once_num: 11 }, { virtual: 0 }, { virtual: 101 },
      { effective_time: 0 }, { images: [] }, { images: Array.from({ length: 11 }, () => '/a.png') }, { type: 2 }, { stock: 100 }, { description: '' },
      { shipping: { delivery_type: [1, 1], freight: 1, postage: '0.00', temp_id: 0 } },
      { skus: [{ base_unique: 'base0001', enabled: true, price: '-1', quota_total: 1, image: '/a.png' }] },
      { skus: [{ base_unique: 'base0001', enabled: true, price: '1', quota_total: 1, image: '/a.png', cost: '0.01' }] }])
      await expect(create(extra)).rejects.toThrow();
    expect((await f.snapshot()).combinations).toHaveLength(0);
  });
  it('preserves damaged legacy fields in detail and permits explicit shutdown and soft deletion', async () => {
    const id = await create(); await f.db.update(storeCombination).set({ status: -1, isShow: 2, startTime: null, people: 0, virtual: 0 }).where(eq(storeCombination.id, id));
    const row = await f.service.detail(id); expect(row).toMatchObject({ status: 0, phase: 'invalid', valid: false, raw: { status: -1, is_show: 2 } });
    await expect(status(id, 1)).rejects.toThrow('损坏'); await status(id, 0);
    await f.service.mutate('delete', id, { revision: (await f.service.detail(id)).revision, request_id: crypto.randomUUID() }, actor);
  });
  it('rejects inconsistent aggregate legacy accounts but does not block lifecycle shutdown', async () => {
    const id = await create(); await f.db.update(storeCombination).set({ quotaShow: 31 }).where(eq(storeCombination.id, id));
    expect((await f.service.detail(id)).valid).toBe(false); await expect(f.service.mutate('update', id, combinationEdit(await f.service.detail(id)), actor)).rejects.toThrow('账目');
    await status(id, 0);
  });
  it('uses exact owner-scoped images including SKU and sanitized HTML with aligned fresh signed previews', async () => {
    await f.db.insert(systemAttachment).values([{ attId: 42, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8,
      attDir: '/api/assets/42', name: 'attachments/admin/1/owned.png', attType: 'image/png' },
    { attId: 43, type: 3, relationId: 11, moduleType: 3, fileType: 1, imageType: 8, attDir: '/api/assets/43', name: 'attachments/user/11/private.png', attType: 'image/png' }]);
    const input = combinationInput({ images: ['/api/assets/42?expires=1&signature=old'], description: '<p onclick="bad()">详情<img src="/api/assets/42"><script>bad()</script></p>' });
    input.skus[0].image = '/api/assets/42'; const id = (await f.service.mutate('create', 0, input, actor)).id, row = await f.service.detail(id);
    expect(row.images).toEqual(['/api/assets/42']); expect(row.images_preview[0]).toMatch(/^\/api\/assets\/42\?expires=/);
    expect(row.description).not.toContain('onclick'); expect(row.description).not.toContain('script'); expect(row.description_preview).toContain('signature=');
    expect(row.skus[0]).toMatchObject({ image: '/api/assets/42', image_preview: expect.stringMatching(/^\/api\/assets\/42\?expires=/) });
    const body = combinationEdit(row, { description: '<img src="/api/assets/43">' }); await expect(f.service.mutate('update', id, body, actor)).rejects.toThrow('所属方');
    await f.db.update(storeCombination).set({ images: '["/api/assets/43"]', image: '/api/assets/43' }).where(eq(storeCombination.id, id));
    const damaged = await f.service.detail(id); expect(damaged.image_preview).toBe(''); expect(damaged.images_preview).toEqual(['']);
  });
  it('inherits supplier private metadata and actual SKU settle/cost, but accepts only own or shared platform image assets', async () => {
    await f.db.insert(systemSupplier).values([{ id: 7, isShow: 1, isDel: 0 }, { id: 8, isShow: 1, isDel: 0 }]);
    await f.db.update(storeProduct).set({ type: 2, relationId: 7, customForm: 'server-private', systemFormId: 12, specs: 'server-specs' }).where(eq(storeProduct.id, 101));
    await f.db.update(storeProductAttrValue).set({ settlePrice: '1.50', diskInfo: 'private-source' }).where(eq(storeProductAttrValue.id, 11));
    const id = await create(), row = await f.service.detail(id); expect(row).toMatchObject({ owner: { type: 2, relation_id: 7 }, source_metadata: { custom_form: 'server-private', system_form_id: 12, specs: 'server-specs' } });
    expect(row.skus[0]).toMatchObject({ settle_price: '1.50', cost: '2.00' });
    await f.db.update(systemSupplier).set({ isShow: 0 }).where(eq(systemSupplier.id, 7)); await expect(status(id, 1)).rejects.toThrow('所属方'); await status(id, 0);
  });
  it('normalizes nonphysical shipping while preserving the configured nonphysical refund flag', async () => {
    await f.db.update(storeProduct).set({ productType: 1 }).where(eq(storeProduct.id, 101));
    const id = await create({ is_support_refund: 0, shipping: { delivery_type: [1], freight: 2, postage: '0.00', temp_id: 0 } });
    expect(await f.service.detail(id)).toMatchObject({ product_type: 1, is_support_refund: 0, shipping: { delivery_type: [2], freight: 2, postage: '0.00', temp_id: 0 } });
  });
  it('filters literal titles, exact IDs, phases and status before bounded coherent pagination', async () => {
    const id = await create({ title: 'A%literal' }); await create({ title: 'B', status: 0 });
    expect(await f.service.list(new URLSearchParams('keyword=%25&limit=1'))).toMatchObject({ count: 1, list: [{ id }] });
    expect((await f.service.list(new URLSearchParams(`keyword=${id}&phase=active&status=1`))).count).toBe(1);
    expect(await f.service.list(new URLSearchParams('page=2&limit=1'))).toMatchObject({ page: 2, limit: 1, count: 2 });
    for (const query of ['limit=101', 'page=10002', 'keyword=a&keyword=b', 'phase=bad', 'type=combination']) await expect(f.service.list(new URLSearchParams(query))).rejects.toThrow();
  });
  it('exposes complete scoped unit/category/hidden-label options and descendant candidates without duplicated relation counts', async () => {
    await f.db.insert(storeProductCategory).values([{ id: 1, cateName: '根' }, { id: 2, pid: 1, cateName: '隐藏子类', isShow: 0 }]);
    await f.db.insert(storeProductLabel).values({ id: 1, labelName: '隐藏标签', status: 0, isShow: 0 });
    await f.db.insert(storeProductRelation).values([{ productId: 101, relationId: 2, type: 1 }, { productId: 101, relationId: 1, type: 3 }, { productId: 101, relationId: 1, type: 3 }]);
    const options = await f.service.options(); expect(options.units).toEqual([{ id: 1, name: '件' }]); expect(options.labels[0].label_name).toBe('隐藏标签');
    expect((await f.service.candidates(new URLSearchParams('category_id=1&label_id=1')))).toMatchObject({ count: 1, list: [{ product_id: 101 }] });
    expect(await f.service.source(101)).toMatchObject({ title: '基础101', images: ['/images/product.png'], description: '<p>来源详情</p>' });
    for (const query of ['category_id=2', 'category_id=999', 'label_id=999', 'category_id=1&category_id=1', 'page=668&limit=15']) await expect(f.service.candidates(new URLSearchParams(query))).rejects.toThrow();
  });
  it('fails closed for invalid UUIDs, versions and attempts to include legacy copy/write metadata', async () => {
    await expect(create({ request_id: 'bad' })).rejects.toThrow('UUID'); await expect(create({ copy: 1 })).rejects.toThrow('字段');
    const id = await create(); await expect(f.service.mutate('status', id, { request_id: crypto.randomUUID(), revision: 'bad', status: 0 }, actor)).rejects.toThrow('版本');
    expect((await f.db.select().from(systemLog))).toHaveLength(1);
  });
  it('rejects source SKU combinations inconsistent with actual display dimensions, with no rebuilt identities', async () => {
    const id = await create(), row = await f.service.detail(id);
    await f.db.update(storeProductAttr).set({ attrValues: '红,绿' }).where(eq(storeProductAttr.productId, 101));
    const before = await f.snapshot(); await expect(f.service.mutate('update', id, combinationEdit(row), actor)).rejects.toThrow('实际维度');
    expect(await f.snapshot()).toEqual(before); await expect(status(id, 1)).rejects.toThrow('实际维度'); await status(id, 0);
  });
  it('retains broken historical SKU identity while explicitly disabling it, and requires all old rows in the body', async () => {
    const id = await create(), [first] = (await f.service.detail(id)).skus;
    await f.db.update(storeProductAttrValue).set({ image: 'javascript:bad', price: '-1.00', suk: 'missing' }).where(eq(storeProductAttrValue.id, first.id));
    const row = await f.service.detail(id); expect(row.skus[0].valid).toBe(false);
    const body = combinationEdit(row); body.skus[0].enabled = false;
    await f.service.mutate('update', id, body, actor); const saved = await f.service.detail(id);
    expect(saved.skus[0]).toMatchObject({ id: first.id, unique: first.unique, retired: true, enabled: false });
    expect(saved.skus[1].enabled).toBe(true); expect((await f.snapshot()).retirements).toHaveLength(1);
  });
  it('requires selected SKU images while preserving the copied private delivery payload on actual activity rows', async () => {
    const input = combinationInput(); input.skus[0].image = ''; await expect(f.service.mutate('create', 0, input, actor)).rejects.toThrow();
    await f.db.update(storeProductAttrValue).set({ diskInfo: 'server-private-secret', writeTimes: 3, writeDays: 30 }).where(eq(storeProductAttrValue.id, 11));
    const id = await create(), row = (await f.snapshot()).skus.find(sku => sku.productId === id && sku.type === 3);
    expect(row).toMatchObject({ diskInfo: 'server-private-secret', writeTimes: 3, writeDays: 30 });
    expect((await f.service.detail(id)).skus[0]).not.toHaveProperty('disk_info');
  });
});
