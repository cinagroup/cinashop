import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { storeBrand, storeCouponIssue, storeCouponProduct, storeProduct, storeProductCategory, systemAttachment, systemSupplier, user } from '@/models/schema';
import { withBuyerInvoices } from './helpers/buyerInvoices';
import { buyerReviewPng, buyerReviewR2 } from './helpers/buyerReviewR2';

type S = Parameters<Parameters<typeof withBuyerInvoices>[0]>[0];
const base = '/api/product/detail/70/coupons';
const uni = base + '?view=uni_product_coupons';
const ids = { first: 953000, platform: 953100, supplier: 953101, private: 953102 };

async function seed(s: S) {
  await s.f.db.update(storeCouponIssue).set({ status: 0 });
  await s.f.db.insert(storeProductCategory).values([{ id: 953, pid: 952 }, { id: 952 }]);
  await s.f.db.insert(storeBrand).values([{ id: 953, pid: 952 }, { id: 952 }]);
  await s.f.db.update(storeProduct).set({ cateId: '953', brandId: 953 }).where(eq(storeProduct.id, 70));
  const r2 = buyerReviewR2(), name = 'attachments/admin/1/uni_coupon_rule.png';
  r2.objects.set(name, { bytes: buyerReviewPng.slice(), contentType: 'image/png' });
  Object.assign(s.env, { ASSETS_BUCKET: r2.bucket });
  await s.f.db.insert(systemAttachment).values([
    { attId: ids.platform, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, name, attDir: '/api/assets/' + ids.platform, attType: 'image/png' },
    { attId: ids.supplier, type: 2, relationId: 7, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/supplier/7/not_coupon.png', attDir: '/api/assets/' + ids.supplier, attType: 'image/png' },
    { attId: ids.private, type: 3, relationId: 11, moduleType: 3, fileType: 1, imageType: 8, name: 'attachments/user/11/private.png', attDir: '/api/assets/' + ids.private, attType: 'image/png' },
  ]);
  const prose = '完整用券规则 😀 与换行\n'.repeat(200);
  const rule = `<h3>适用规则标题</h3><p>${prose}</p><ul><li>不可与其他券叠加</li></ul><table><tr><td>使用说明</td></tr></table>`
    + `<img src="/api/assets/${ids.platform}" onerror="globalThis.couponUnsafe=1" alt="平台规则图">`
    + `<img src="https://legacy.invalid/api/assets/${ids.supplier}?expires=1&amp;signature=old" alt="供应商不授予券规则权限">`
    + `<img src="%2fapi%2fassets%2f${ids.private}" alt="客户私有图片">`
    + '<script>PRIVATE_SCRIPT_BODY</script><style>PRIVATE_STYLE_BODY</style><iframe>PRIVATE_FRAME_BODY</iframe><a href="javascript:alert(1)">说明</a>';
  const now = Date.now();
  for (let index = 0; index < 21; index++) {
    const scope = index % 4;
    await s.f.db.insert(storeCouponIssue).values({ id: ids.first + index, couponTitle: '完整商品券 ' + (index + 1), category: 0,
      couponType: scope, type: index % 2 ? 2 : 1, couponPrice: index % 2 ? '85.00' : '5.00', useMinPrice: '20.00',
      productId: scope === 2 ? '70' : '0', category_id: scope === 1 ? '952' : '0', brandId: scope === 3 ? '952' : '0',
      day: index % 2 ? 0 : 7, useStartTime: new Date(now - 86400000), useEndTime: new Date(now + 86400000),
      status: 1, receiveType: 1, appType: 0, receiveLimit: 2, totalCount: 5, remainCount: 5, sort: 1000 - index,
      rule: index === 0 ? rule : index === 1 ? null : `<p>第 ${index + 1} 张券完整规则</p>` });
  }
  await s.f.db.insert(storeCouponProduct).values([{ couponId: ids.first + 2, productId: 70 }, { couponId: ids.first + 2, productId: 70 }]);
  return { r2, name, prose };
}

/** Include all business tables and sequences, not only coupon rows. These GETs
 * must leave even non-transactional sequence state exactly unchanged. */
async function snapshot(s: S) {
  const names = await s.f.exec("SELECT relname AS name,relkind AS kind FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','S') ORDER BY relname");
  const result: Record<string, unknown> = {};
  for (const { name, kind } of names) {
    expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    result[String(name)] = await s.f.exec(kind === 'S'
      ? `SELECT last_value,is_called FROM public."${name}"`
      : `SELECT to_jsonb(t) AS row FROM public."${name}" t ORDER BY to_jsonb(t)::text`);
  }
  return result;
}
async function ok(s: S, path = uni, bearer?: string | null) {
  const result = await s.request(path, undefined, bearer);
  expect(result.status, result.msg).toBe(200);
  expect(result.headers.get('cache-control')).toContain('no-store');
  return result.data;
}

it('reads complete 10/10/1 Uni coupon pages and full safe rules with platform-only asset entitlement on the real restricted LOGIN', async () => withBuyerInvoices(async s => {
  const f = await seed(s), before = await snapshot(s);
  const pages = await Promise.all([ok(s, uni + '&page=1', null), ok(s, uni + '&page=2', null), ok(s, uni + '&page=3', null)]);
  expect(pages.map(page => page.items.length)).toEqual([10, 10, 1]);
  expect(pages.every(page => page.view === 'uni_product_coupons' && page.uid === 0 && page.total === 21)).toBe(true);
  expect(new Set(pages.flatMap(page => page.items.map((item: { id: number }) => item.id))).size).toBe(21);
  const first = pages[0].items[0], rule = first.rule as string;
  expect(rule).toContain(f.prose); expect(rule).toContain('<h3>适用规则标题</h3>');
  expect(rule).toContain('<ul><li>不可与其他券叠加</li></ul>'); expect(rule).toContain('<td>使用说明</td>');
  expect(rule).not.toMatch(/onerror|javascript:|PRIVATE_(SCRIPT|STYLE|FRAME)_BODY|<script|<style|<iframe/);
  expect(rule).not.toContain('/api/assets/' + ids.supplier); expect(rule).not.toContain('/api/assets/' + ids.private);
  expect(pages[0].items[1]).toMatchObject({ scopeType: 1, benefitType: 2, benefitValue: '85.00', rule: '', validity: { kind: 'fixed' } });
  expect(new Set(pages[0].items.slice(0, 4).map((item: { scopeType: number }) => item.scopeType))).toEqual(new Set([0, 1, 2, 3]));
  const asset = rule.match(/src="(\/api\/assets\/953100\?[^\"]+)"/)?.[1]; expect(asset).toBeTruthy();
  const image = await s.fetch(new Request('http://127.0.0.1' + asset!.replaceAll('&amp;', '&')));
  expect(image.status).toBe(200); expect(new Uint8Array(await image.arrayBuffer())).toEqual(buyerReviewPng);
  expect(f.r2.reads).toEqual([f.name]); expect(f.r2.writes).toEqual([]); expect(f.r2.deletes).toEqual([]);
  expect(await snapshot(s)).toEqual(before);
}), 120000);

it('rejects oversized whole rules/pages without truncation while preserving the exact existing default and legacy directory projections', async () => withBuyerInvoices(async s => {
  await seed(s);
  const original = await ok(s, base), legacy = await ok(s, '/api/coupons?product_id=70&limit=50');
  expect(original).not.toHaveProperty('view'); expect(original.items.every((row: object) => !Object.hasOwn(row, 'rule'))).toBe(true);
  await s.f.db.update(storeCouponIssue).set({ rule: 'a'.repeat(64001) }).where(eq(storeCouponIssue.id, ids.first));
  let before = await snapshot(s);
  const tooLong = await s.request(uni); expect(tooLong.status).not.toBe(200); expect(tooLong.msg).toContain('完整规则');
  expect(await ok(s, base)).toEqual(original); expect(await ok(s, '/api/coupons?product_id=70&limit=50')).toEqual(legacy);
  expect(await snapshot(s)).toEqual(before);
  await s.f.db.update(storeCouponIssue).set({ rule: '汉'.repeat(60000) });
  before = await snapshot(s);
  const tooLarge = await s.request(uni); expect(tooLarge.status).not.toBe(200); expect(tooLarge.msg).toContain('整页');
  expect(await ok(s, base)).toEqual(original); expect(await snapshot(s)).toEqual(before);
}), 120000);

it('keeps selectors, live account/product admission and claim receipts authoritative for the Uni view without granting from a directory GET', async () => withBuyerInvoices(async s => {
  await seed(s); const bearer = await s.token(), before = await snapshot(s);
  for (const query of ['view=uni_product_coupons&view=uni_product_coupons', 'view=other', 'view=uni_product_coupons&uid=22', 'view=uni_product_coupons&page=01'])
    expect((await s.request(base + '?' + query)).status).not.toBe(200);
  expect((await ok(s)).uid).toBe(11); expect((await ok(s, uni, await s.token(22))).uid).toBe(22);
  expect(await ok(s, base + '/' + ids.first + '/receipt')).toMatchObject({ uid: 11, receivedCount: 0, latestCouponUserId: null });
  expect(await snapshot(s)).toEqual(before);
  await s.f.db.update(user).set({ pwd: 'changed-local-coupon-password' }).where(eq(user.uid, 11));
  expect((await ok(s, uni, bearer)).uid).toBe(0);
  expect((await s.request(base + '/' + ids.first + '/receipt', undefined, bearer)).status).not.toBe(200);
  await s.f.db.update(systemSupplier).set({ isShow: 0 }).where(eq(systemSupplier.id, 7));
  expect((await s.request(uni)).status).not.toBe(200);
}), 120000);

it('matches PHP parent-product coupon scopes for a public supplier child while keeping the requested child identity and existing PC projection', async () => withBuyerInvoices(async s => {
  await seed(s); const original = await ok(s, base);
  await s.f.db.insert(storeProduct).values({ id: 80, type: 0, relationId: 0, pid: 0, isShow: 1, isVerify: 1, storeName: '平台父商品' });
  await s.f.db.update(storeProduct).set({ pid: 80 }).where(eq(storeProduct.id, 70));
  const issue = { category: 0, couponType: 2, type: 1, couponPrice: '1.00', useMinPrice: '0.00', day: 7,
    status: 1, receiveType: 1, appType: 0, receiveLimit: 1, remainCount: 5, totalCount: 5, rule: '<p>父商品规则</p>' };
  await s.f.db.insert(storeCouponIssue).values([
    { ...issue, id: 953022, productId: '80', sort: 2000, couponTitle: '父商品直接范围券' },
    { ...issue, id: 953023, sort: 1999, couponTitle: '父商品关联范围券' },
    { ...issue, id: 953024, productId: '99999', sort: 1998, couponTitle: '不适用其他父商品券' },
  ]);
  await s.f.db.insert(storeCouponProduct).values([{ couponId: 953023, productId: 80 }, { couponId: 953023, productId: 80 }]);
  const before = await snapshot(s), result = await ok(s, uni + '&limit=50');
  expect(result).toMatchObject({ uid: 11, productId: 70, total: 18 });
  expect(result.items.slice(0, 2).map((row: { id: number }) => row.id)).toEqual([953022, 953023]);
  expect(result.items.filter((row: { scopeType: number }) => row.scopeType === 2).map((row: { id: number }) => row.id)).toEqual([953022, 953023]);
  expect(await ok(s, base)).toEqual(original); expect(await snapshot(s)).toEqual(before);
}), 120000);
