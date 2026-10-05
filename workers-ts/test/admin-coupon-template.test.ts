import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { storeCouponIssue, storeCouponProduct, storeCouponTemplate, storeCouponTemplateIssue, storeProduct, systemLog } from '../src/models/schema';
import { couponTemplateCreate, couponTemplateMoney, couponTemplatePublish, couponTemplateQuery } from '../src/services/admin/AdminCouponTemplateInput';
import { couponTemplateFixture, publicationBody, templateBody } from './helpers/couponTemplateFixture';

const q = (value = '') => new URLSearchParams(value), actor = { id: 8 };
describe('strict reusable coupon template contracts', () => {
  it.each(['', '01', '-1', 'NaN', 'Infinity', '1e2', '0.001', '10000000000', 1, null])('rejects non-decimal12,2 money %s', value => {
    expect(() => couponTemplateMoney(value)).toThrow();
  });
  it.each(['page=0', 'page=01', 'limit=101', 'page=102&limit=100', 'page=1&page=1', 'keyword=%00', 'status=2', 'status=all', 'arbitrary=1'])('refuses malformed query %s', value => {
    expect(() => couponTemplateQuery(q(value))).toThrow();
  });
  it('normalizes exact cents/scope and keeps bounded all-state pages without silently truncating', () => {
    expect(couponTemplateCreate(templateBody())).toMatchObject({ productIds: '4100,4101', couponPrice: '5.10', useMinPrice: '10.00' });
    expect(couponTemplateQuery(q('status=&page=10001&limit=1'))).toMatchObject({ status: undefined, offset: 10000 });
    expect(couponTemplateMoney('9999999999.99')).toBe('9999999999.99');
    expect(() => couponTemplateCreate(templateBody({ product_ids: [4100, 4100] }))).toThrow('重复');
    expect(() => couponTemplateCreate(templateBody({ scope_type: 0 }))).toThrow('不一致');
    expect(() => couponTemplateCreate(templateBody({ product_ids: Array.from({ length: 101 }, (_, i) => i + 1) }))).toThrow('100');
    expect(() => couponTemplateCreate(templateBody({ valid_days: 0 }))).toThrow();
    expect(() => couponTemplateCreate(templateBody({ valid_days: 3651 }))).toThrow();
    expect(() => couponTemplateQuery(q('status=1'), 'products')).toThrow();
    expect(() => couponTemplateQuery(q('keyword=x'), 'issues')).toThrow();
  });
  it('enforces publication count, mode metadata, exact paired UTC dates and forbids overflow/normalization', () => {
    expect(couponTemplatePublish(publicationBody(1, 'a'.repeat(64)))).toMatchObject({ count: 5, fullReduction: '0.00' });
    for (const override of [{ count: 0 }, { count: 1, is_permanent: 1 }, { receive_type: 4 }, { full_reduction: '1' },
      { start_time: '2028-01-01T00:00:00Z' }, { start_time: '2028-02-30T00:00:00Z', end_time: '2028-03-03T00:00:00Z' },
      { start_time: '2028-01-01T00:00:00+08:00', end_time: '2028-02-01T00:00:00Z' },
      { start_time: '2028-01-01T00:00:00Z', end_time: '2028-01-01T00:00:00Z' }])
      expect(() => couponTemplatePublish(publicationBody(1, 'a'.repeat(64), override))).toThrow();
  });
});

describe('real SQL reusable template and independent publication', () => {
  let f: Awaited<ReturnType<typeof couponTemplateFixture>>;
  beforeEach(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No external I/O')); f = await couponTemplateFixture(); }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  it('reads bounded source/options/products/history without writes, literal wildcards, and deleted-source visibility', async () => {
    const before = await f.snapshot();
    const page = await f.service.list(q('limit=1'));
    expect(page).toMatchObject({ count: 3, page: 1, limit: 1 }); expect(page.list[0].id).toBe(45001);
    expect((await f.service.list(q('keyword=模板%25_'))).list.map(row => row.id)).toEqual([45001]);
    expect((await f.service.list(q('status='))).count).toBe(4);
    expect(await f.service.options()).toMatchObject({ categories: [{ id: 4001, pid: 0, cate_name: '真实商品分类' }], max_products: 100, max_product_ids_length: 500 });
    expect((await f.service.products(q('keyword=选择商品%25_'))).list).toEqual([{ id: 4100, store_name: '选择商品%_', deleted: false }]);
    expect(await f.service.detail('45004')).toMatchObject({ deleted: true, issue_count: 0 });
    expect(await f.service.detail('45005')).toMatchObject({ valid: false, products: [{ id: 4102, deleted: true }], issues: ['适用商品4102已删除'] });
    expect(await f.service.issues('45001', q())).toMatchObject({ count: 0, list: [] });
    await expect(f.service.detail('999')).rejects.toMatchObject({ code: 404 });
    expect(await f.snapshot()).toEqual(before);
  });
  it('creates only an immutable source, publishes independent exact financial/scope snapshots, and proves exact replay', async () => {
    const create = templateBody();
    const result = await f.service.mutate('create', undefined, create, actor);
    expect(result).toEqual({ id: 1 }); expect(await f.service.mutate('create', undefined, create, actor)).toEqual(result);
    const source = await f.service.detail('1'); expect(source).toMatchObject({ product_ids: [4100, 4101], issue_count: 0, coupon_price: '5.10' });
    const pub = publicationBody(1, source.revision), issued = await f.service.mutate('publish', undefined, pub, actor);
    expect(issued).toEqual({ issue_id: 1, template_id: 1 });
    expect(await f.service.mutate('publish', undefined, pub, actor)).toEqual(issued);
    expect((await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, 1)))[0]).toMatchObject({ cid: 1, category: 0, appType: 0,
      couponType: 2, type: 1, couponPrice: '5.10', useMinPrice: '10.00', day: 7, productId: '4100,4101', legacyProductIds: '4100,4101',
      receiveType: 1, receiveLimit: 1, totalCount: 5, remainCount: 5 });
    expect(await f.db.select().from(storeCouponProduct).where(eq(storeCouponProduct.couponId, 1))).toEqual([{ couponId: 1, productId: 4100 }, { couponId: 1, productId: 4101 }]);
    expect((await f.db.select().from(storeCouponTemplateIssue))[0]).toMatchObject({ templateId: 1, issueId: 1, sourceRevision: source.revision });
    expect((await f.service.issues('1', q())).list[0]).toMatchObject({ issue_id: 1, template_id: 1, source_revision: source.revision, start_time: null, end_time: null });
    expect((await f.service.detail('1')).revision).toBe(source.revision);
    await expect(f.service.mutate('publish', undefined, { ...pub, count: 6 }, actor)).rejects.toThrow('请求标识');
    await expect(f.service.mutate('create', undefined, { ...create, title: 'changed' }, actor)).rejects.toThrow('请求标识');
  });
  it('keeps each publication independent and exact modes without changing registration configuration or inventing automatic grants', async () => {
    const source = await f.service.detail('45002');
    for (const receiveType of [1, 2, 3]) {
      const result = await f.service.mutate('publish', undefined, publicationBody(source.id, source.revision,
        { receive_type: receiveType, is_permanent: 1, count: 0, full_reduction: receiveType === 3 ? '20' : '0' }), actor);
      if (!('issue_id' in result)) throw Error('Missing issue identity');
      const [row] = await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, result.issue_id));
      expect(row).toMatchObject({ couponType: 1, category_id: '4001', legacyCategoryId: 4001, productId: '0', type: 1,
        receiveType, isPermanent: 1, remainCount: 0, isFullGive: receiveType === 3 ? 1 : 0, isGiveSubscribe: receiveType === 2 ? 1 : 0 });
    }
    expect((await f.service.issues('45002', q('limit=2'))).list.map(row => row.issue_id)).toEqual([3, 2]);
    expect((await f.service.issues('45002', q('limit=2&page=2'))).list.map(row => row.issue_id)).toEqual([1]);
    expect((await f.snapshot()).store_coupon_user).toEqual([]);
    expect((await f.snapshot()).store_coupon_issue_user).toEqual([]);
  });
  it('invalidates only immutable proof-linked issues despite matching legacy cid, preserves scopes, and replays after state changes', async () => {
    const created = await f.service.mutate('create', undefined, templateBody(), actor); if (!('id' in created)) throw Error('Missing source');
    const source = await f.service.detail(String(created.id)), pub = publicationBody(source.id, source.revision);
    const issued = await f.service.mutate('publish', undefined, pub, actor); if (!('issue_id' in issued)) throw Error('Missing issue');
    const scopes = await f.db.select().from(storeCouponProduct);
    const invalid = { request_id: crypto.randomUUID(), revision: source.revision };
    expect(await f.service.mutate('invalidate', String(source.id), invalid, actor)).toEqual({ id: source.id });
    expect((await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, issued.issue_id)))[0].status).toBe(-1);
    expect((await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, 46001)))[0].status).toBe(1);
    expect(await f.db.select().from(storeCouponProduct)).toEqual(scopes);
    expect(await f.service.mutate('invalidate', String(source.id), invalid, actor)).toEqual({ id: source.id });
    expect(await f.service.mutate('publish', undefined, pub, actor)).toEqual(issued);
    const fresh = await f.service.detail(String(source.id));
    await expect(f.service.mutate('publish', undefined, publicationBody(source.id, fresh.revision), actor)).rejects.toThrow('失效');
    const [log] = await f.db.select().from(systemLog).where(eq(systemLog.path, `/marketing/coupon-templates/request/${invalid.request_id}`));
    expect(log.method).toBe('POST');
  });
  it('deletes only source, preserves issue/relations/proof, makes new publication impossible and keeps original replay', async () => {
    const source = await f.service.detail('45001'), pub = publicationBody(source.id, source.revision);
    const issued = await f.service.mutate('publish', undefined, pub, actor), before = await f.snapshot();
    const body = { request_id: crypto.randomUUID(), revision: source.revision };
    expect(await f.service.mutate('delete', '45001', body, actor)).toEqual({ id: 45001 });
    for (const key of ['store_coupon_issue', 'store_coupon_product', 'store_coupon_template_issue']) expect((await f.snapshot())[key]).toEqual(before[key]);
    const deleted = await f.service.detail('45001'); expect(deleted.deleted).toBe(true);
    await expect(f.service.mutate('publish', undefined, publicationBody(45001, deleted.revision), actor)).rejects.toThrow('删除');
    expect(await f.service.mutate('publish', undefined, pub, actor)).toEqual(issued);
    expect(await f.service.mutate('delete', '45001', body, actor)).toEqual({ id: 45001 });
  });
  it('rejects stale, tampered, collection-vs-path identity, expired times and newly deleted scope without business writes', async () => {
    const source = await f.service.detail('45001'), before = await f.snapshot();
    for (const [operation, id, body] of [
      ['publish', '45001', publicationBody(45001, source.revision)],
      ['publish', undefined, publicationBody(45001, 'a'.repeat(64))],
      ['publish', undefined, publicationBody(45001, source.revision, { template_id: '45001' })],
      ['publish', undefined, publicationBody(45001, source.revision, { coupon_price: '99' })],
      ['publish', undefined, publicationBody(45001, source.revision, { start_time: '2020-01-01T00:00:00Z', end_time: '2020-01-02T00:00:00Z' })],
      ['create', undefined, templateBody({ product_ids: [4102] })],
      ['create', undefined, templateBody({ scope_type: 1, category_id: 4002, product_ids: [] })],
      ['invalidate', '45001', { request_id: 'not-a-uuid', revision: source.revision }],
    ] as const) await expect(f.service.mutate(operation, id, body, actor)).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before);
    await f.db.update(storeProduct).set({ isDel: 1 }).where(eq(storeProduct.id, 4100));
    const after = await f.snapshot();
    await expect(f.service.mutate('publish', undefined, publicationBody(45001, source.revision), actor)).rejects.toThrow('商品');
    expect(await f.snapshot()).toEqual(after);
  });
  it('rolls back source, scope and publication if audit insertion fails, then reuses the same UUID exactly once', async () => {
    const source = await f.service.detail('45001'), body = publicationBody(45001, source.revision), before = await f.snapshot();
    await f.exec("ALTER TABLE system_log ADD CONSTRAINT coupon_template_failure_probe CHECK(type <> 'coupon_template')");
    await expect(f.service.mutate('publish', undefined, body, actor)).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before);
    await f.exec('ALTER TABLE system_log DROP CONSTRAINT coupon_template_failure_probe');
    const result = await f.service.mutate('publish', undefined, body, actor);
    expect(await f.service.mutate('publish', undefined, body, actor)).toEqual(result);
    expect((await f.service.issues('45001', q())).count).toBe(1);
    const create = templateBody(); await f.exec("ALTER TABLE system_log ADD CONSTRAINT coupon_template_failure_probe CHECK(type <> 'coupon_template') NOT VALID");
    const later = await f.snapshot(); await expect(f.service.mutate('create', undefined, create, actor)).rejects.toThrow();
    expect(await f.snapshot()).toEqual(later);
  });
  it('refuses missing or forged replay proof rather than generating another issuance', async () => {
    const source = await f.service.detail('45001'), body = publicationBody(45001, source.revision);
    const result = await f.service.mutate('publish', undefined, body, actor); if (!('issue_id' in result)) throw Error('Missing issue');
    await f.db.delete(storeCouponTemplateIssue).where(eq(storeCouponTemplateIssue.issueId, result.issue_id));
    const before = await f.snapshot(); await expect(f.service.mutate('publish', undefined, body, actor)).rejects.toThrow('来源证据');
    expect(await f.snapshot()).toEqual(before);
    await f.db.update(systemLog).set({ action: 'forged' }).where(eq(systemLog.path, `/marketing/coupon-templates/request/${body.request_id}`));
    await expect(f.service.mutate('publish', undefined, body, actor)).rejects.toThrow('请求标识');
  });
  it('marks source invalid after scope disappears but allows one-way lifecycle repair and keeps revisions independent of history counts', async () => {
    await f.db.delete(storeProduct).where(eq(storeProduct.id, 4100));
    const row = await f.service.detail('45001'); expect(row.valid).toBe(false); expect(row.issues).toContain('适用商品4100缺失');
    expect(await f.service.mutate('invalidate', '45001', { request_id: crypto.randomUUID(), revision: row.revision }, actor)).toEqual({ id: 45001 });
    expect((await f.db.select().from(storeCouponTemplate).where(eq(storeCouponTemplate.id, 45001)))[0].status).toBe(0);
  });
});
