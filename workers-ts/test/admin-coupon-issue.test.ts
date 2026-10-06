import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { storeBrand, storeCouponIssue, storeCouponIssueUser, storeCouponProduct, storeCouponTemplate,
  storeCouponTemplateIssue, storeCouponUser, storeProduct, storeProductCoupon, systemLog } from '../src/models/schema';
import { ActivityService } from '../src/services/activity/ActivityService';
import { couponIssueBody, couponIssueFixture } from './helpers/couponIssueFixture';
import { publicationBody, templateBody } from './helpers/couponTemplateFixture';

const actor = { id: 8 }, q = (value = '') => new URLSearchParams(value);
describe('Independent issued coupon workflow on actual SQL', () => {
  let f: Awaited<ReturnType<typeof couponIssueFixture>>;
  beforeEach(async () => { f = await couponIssueFixture(); }, 30000);
  afterEach(async () => { await f?.close(); }, 30000);
  const create = (changes: Record<string, unknown> = {}) => f.service.mutate('create', undefined, couponIssueBody(changes), actor);
  it('lists the whole paginated source, literal search and filters without inventing a discount from scope type', async () => {
    await f.db.insert(storeCouponIssue).values(Array.from({ length: 120 }, (_, i) => ({ id: 47000 + i, couponTitle: i === 20 ? '命中%_' : `历史${i}`,
      title: `历史${i}`, type: i % 2 ? 2 : 1, couponType: i % 4, couponPrice: '80.50', day: 7, receiveType: i % 2 ? 3 : 1,
      category: 0, isPermanent: 1, status: i < 10 ? 0 : 1, addTime: i })));
    const before = await f.snapshot(), all = await f.service.list(q('status=&page=8&limit=15'));
    expect(all).toMatchObject({ count: 121, page: 8, limit: 15 }); expect(all.list).toHaveLength(15);
    expect(new Set(all.list.map(row => row.id)).size).toBe(15);
    expect((await f.service.list(q('keyword=%25_&status='))).list.map(row => row.id)).toEqual([47020]);
    const filtered = await f.service.list(q('discount_type=2&receive_type=3&status=1'));
    expect(filtered.count).toBe(55); expect(filtered.list.every(row => row.discount_type === 2 && row.receive_type === 3)).toBe(true);
    expect(await f.snapshot()).toEqual(before);
  });
  it('creates all four scopes including genuine brand hierarchy and maintains canonical financial aliases', async () => {
    const definitions = [{}, { scope_type: 1, category_id: 4001 }, { scope_type: 2, product_ids: [4101, 4100] },
      { scope_type: 3, brand_id: 4501, discount_type: 2, coupon_price: '85.99' }];
    for (const definition of definitions) {
      const { id } = await create(definition), row = await f.service.detail(String(id));
      expect(row).toMatchObject({ id, valid: true, category: 0, cid: 0, source_template: null, total_count: 5, remain_count: 5, receive_limit: 1 });
      expect(row.coupon_price).toBe(definition.coupon_price ?? '5.10');
      const [saved] = await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, id));
      if (row.scope_type === 2) {
        expect(saved).toMatchObject({ productId: '4100,4101', legacyProductIds: '4100,4101' });
        expect((await f.db.select().from(storeCouponProduct).where(eq(storeCouponProduct.couponId, id))).map(p => p.productId).sort()).toEqual([4100, 4101]);
      }
      if (row.scope_type === 3) expect(saved).toMatchObject({ brandId: '4501', legacyBrandId: 4501, type: 2, couponType: 3 });
    }
    expect((await f.service.options()).brands.map(row => row.id)).toEqual(expect.arrayContaining([4500, 4501]));
    expect((await f.service.products(q('keyword=%25_'))).list.map(row => row.id)).toEqual([4100]);
  });
  it('copies a proof-linked issue as a new independent definition, leaving source financials, stock and provenance intact', async () => {
    const source = await f.templates.mutate('create', undefined, templateBody(), actor);
    if (!('id' in source)) throw Error('Expected template identity');
    const sourceRow = await f.templates.detail(String(source.id));
    const published = await f.templates.mutate('publish', undefined, publicationBody(source.id, sourceRow.revision), actor);
    if (!('issue_id' in published)) throw Error('Expected issued identity');
    const old = await f.service.copy(String(published.issue_id)); expect(old.source_template?.template_id).toBe(source.id);
    expect(old.copy_input).not.toBeNull();
    const beforeSource = (await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, old.id)))[0];
    const result = await create({ ...old.copy_input, source_id: old.id, source_revision: old.revision, title: '复制新品牌券',
      scope_type: 3, category_id: 0, brand_id: 4501, product_ids: [] });
    expect(result.id).not.toBe(old.id); expect(await f.service.detail(String(result.id))).toMatchObject({ cid: 0, source_template: null, title: '复制新品牌券', remain_count: 5 });
    expect((await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, old.id)))[0]).toEqual(beforeSource);
    expect(await f.db.select().from(storeCouponTemplateIssue)).toHaveLength(1);
    expect((await f.db.select().from(storeCouponProduct).where(eq(storeCouponProduct.couponId, old.id))).map(row => row.productId).sort()).toEqual([4100, 4101]);
  });
  it('retains member identity and normalizes source-only legacy values without creating gifted inventory', async () => {
    await f.db.update(storeCouponIssue).set({ category: 2, receiveType: 4, status: -1, isPermanent: 1, totalCount: 0, remainCount: 0 })
      .where(eq(storeCouponIssue.id, 46001));
    const source = await f.service.copy('46001');
    expect(source.copy_input).toMatchObject({ category: 2, receive_type: 4, status: 0, is_permanent: 1, total_count: 0 });
    const { id } = await create({ ...source.copy_input, source_id: source.id, source_revision: source.revision });
    expect(await f.service.detail(String(id))).toMatchObject({ category: 2, receive_type: 4, status: 0, source_template: null, cid: 0 });
    expect(await f.db.select().from(storeCouponUser)).toHaveLength(0);
    await f.db.update(storeCouponIssue).set({ category: 1, receiveType: 1, status: 1 }).where(eq(storeCouponIssue.id, 46001));
    expect((await f.service.copy('46001')).copy_input?.category).toBe(0);
    await f.db.update(storeCouponIssue).set({ appType: 1 }).where(eq(storeCouponIssue.id, 46001));
    const protectedSource = await f.service.copy('46001');
    expect(protectedSource.copy_input).toBeNull(); expect(protectedSource.issues.join(' ')).toContain('受众');
    const before = await f.snapshot();
    await expect(create({ source_id: protectedSource.id, source_revision: protectedSource.revision })).rejects.toThrow('受众');
    expect(await f.snapshot()).toEqual(before);
  });
  it('replays a confirmed UUID once and rejects payload, actor and stale-source identities without new business mutations', async () => {
    const body = couponIssueBody(), first = await f.service.mutate('create', undefined, body, actor), before = await f.snapshot();
    expect(await f.service.mutate('create', undefined, body, actor)).toEqual(first);
    expect(await f.snapshot()).toEqual(before);
    await expect(f.service.mutate('create', undefined, { ...body, coupon_price: '6.00' }, actor)).rejects.toThrow();
    await expect(f.service.mutate('create', undefined, couponIssueBody(), { id: 0 })).rejects.toThrow();
    const source = await f.service.copy(String(first.id));
    await expect(create({ ...source.copy_input, source_id: first.id, source_revision: '0'.repeat(64) })).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before);
  });
  it('keeps claim history separate by issuer and source without multiplying repeated evidence or losing orphan users', async () => {
    await f.db.insert(storeCouponIssueUser).values([{ uid: 4110, issueCouponId: 46001, addTime: 10 },
      { uid: 4110, issueCouponId: 46001, addTime: 10 }, { uid: 99999, issueCouponId: 46001, addTime: 20 }]);
    await f.db.insert(storeCouponUser).values({ uid: 4110, issueCouponId: 46001, status: 3, receiveTime: 99 });
    const ordinary = await f.service.claims('46001', q());
    expect(ordinary).toMatchObject({ issue_id: 46001, source: 'issue_log', count: 3 }); expect(ordinary.list).toHaveLength(3);
    expect(ordinary.list.filter(row => row.uid === 4110)).toHaveLength(2); expect(ordinary.list[0].missing_user).toBe(true);
    expect(new Set(ordinary.list.map(row => row.row_key)).size).toBe(3);
    const { id } = await create({ category: 2 });
    await f.db.insert(storeCouponIssueUser).values({ uid: 4110, issueCouponId: id, addTime: 30 });
    await f.db.insert(storeCouponUser).values({ uid: 4110, issueCouponId: id, status: 3, receiveTime: 40 });
    const member = await f.service.claims(String(id), q());
    expect(member).toMatchObject({ source: 'owned', count: 1 }); expect(member.list[0]).toMatchObject({ uid: 4110, add_time: 40 });
  });
  it('soft-deletes only future issuance while preserving owned/reserved, scope, gift metadata and the deducted stock', async () => {
    const { id } = await create({ scope_type: 2, product_ids: [4100] });
    const row = await f.service.detail(String(id)), claimed = await new ActivityService(f.container).receiveCoupon(4110, id);
    await f.db.update(storeCouponUser).set({ status: 3 }).where(eq(storeCouponUser.id, claimed.couponUserId));
    await f.db.insert(storeProductCoupon).values({ productId: 4100, issueCouponId: id });
    const before = await f.snapshot();
    expect((await f.service.detail(String(id))).revision).toBe(row.revision);
    await f.service.mutate('delete', String(id), { request_id: crypto.randomUUID(), revision: row.revision }, actor);
    const after = await f.snapshot();
    for (const table of ['store_coupon_user', 'store_coupon_issue_user', 'store_coupon_product', 'store_product_coupon', 'store_coupon_template_issue']) expect(after[table]).toEqual(before[table]);
    expect(await f.service.detail(String(id))).toMatchObject({ deleted: true, status: -1, remain_count: 4 });
    await expect(new ActivityService(f.container).receiveCoupon(4110, id)).rejects.toThrow();
  });
  it('preserves explicit independent reactivation after source invalidation without reactivating the source', async () => {
    const source = await f.templates.mutate('create', undefined, templateBody(), actor);
    if (!('id' in source)) throw Error('Expected template');
    const template = await f.templates.detail(String(source.id));
    const result = await f.templates.mutate('publish', undefined, publicationBody(source.id, template.revision), actor);
    if (!('issue_id' in result)) throw Error('Expected issue');
    await f.templates.mutate('invalidate', String(source.id), { request_id: crypto.randomUUID(), revision: template.revision }, actor);
    const issue = await f.service.detail(String(result.issue_id)); expect(issue.status).toBe(-1);
    await f.service.mutate('status', String(issue.id), { request_id: crypto.randomUUID(), revision: issue.revision, status: 1 }, actor);
    expect((await f.service.detail(String(issue.id))).status).toBe(1);
    expect((await f.db.select().from(storeCouponTemplate).where(eq(storeCouponTemplate.id, source.id)))[0].status).toBe(0);
    expect(await f.db.select().from(storeCouponTemplateIssue)).toHaveLength(1);
  });
  it('rejects hidden/deleted scope and ambiguous legacy aliases while retaining the historical row for diagnosis', async () => {
    await f.db.update(storeBrand).set({ isShow: 0 }).where(eq(storeBrand.id, 4500));
    const before = await f.snapshot();
    for (const changes of [{ scope_type: 1, category_id: 4002 }, { scope_type: 2, product_ids: [4102] }, { scope_type: 3, brand_id: 4501 }]) await expect(create(changes)).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before);
    await f.db.update(storeCouponIssue).set({ couponType: 2, productId: '4100', legacyProductIds: '4101' }).where(eq(storeCouponIssue.id, 46001));
    const row = await f.service.detail('46001'); expect(row).toMatchObject({ valid: false, copy_input: null }); expect(row.issues.length).toBeGreaterThan(0);
    const snapshot = await f.snapshot(); await expect(create({ source_id: row.id, source_revision: row.revision })).rejects.toThrow();
    expect(await f.snapshot()).toEqual(snapshot);
  });
  it('rolls back new issuer, scope and receipt together on a real failing audit INSERT', async () => {
    await f.exec("CREATE FUNCTION public.reject_coupon_issue_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='coupon_issue' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_coupon_issue_audit BEFORE INSERT ON public.system_log FOR EACH ROW EXECUTE FUNCTION public.reject_coupon_issue_audit()");
    const before = await f.snapshot();
    await expect(create({ scope_type: 2, product_ids: [4100] })).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before);
    expect((await f.db.select().from(systemLog)).filter(row => row.type === 'coupon_issue')).toHaveLength(0);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 4100)))[0].isDel).toBe(0);
  });
});
