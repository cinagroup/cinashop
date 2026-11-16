import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createToken, md5 } from '@/utils/jwt';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { memberRight, storeBrand, storeCart, storeCouponIssue, storeCouponIssueUser, storeCouponProduct, storeCouponUser,
  storeOrder, storeProduct, storeProductAttrValue, storeProductCategory, storePromotions,
  systemConfig, systemStore, systemSupplier, systemUserLevel, user } from '@/models/schema';
import { decodePublicProductEstimate, type PublicProductEstimate } from '../../view/common/publicProductEstimate';
import { withBuyerInvoices } from './helpers/buyerInvoices';

type Buyer = Parameters<Parameters<typeof withBuyerInvoices>[0]>[0];
type Harness = { s: Buyer; writes: Array<{ operation: string; key?: string }>; stale: Map<string, string>; allowCheckoutKv: boolean };
const BASE = '/api/product/detail/activity/70?view=uni_product_estimate_v1';
const PATH = BASE + '&unique=qared001';
const ID = 957000;
const safeRows = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value) || value.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw Error('Native PG rows missing');
  return value as Record<string, unknown>[];
};
const rowOrder = (a: Record<string, unknown>, b: Record<string, unknown>) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en');
/** Every table and nontransactional sequence in the actual migrated database,
 * including empty tables. This is deliberately broader than business fixtures. */
async function snapshot(s: Buyer) {
  const objects = safeRows(await s.f.exec("SELECT relname AS name,relkind AS kind FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','S') ORDER BY relname"));
  expect(objects.filter(row => row.kind === 'r')).toHaveLength(283);
  expect(objects.filter(row => row.kind === 'S').length).toBeGreaterThan(200);
  const image: Record<string, unknown> = {};
  for (const object of objects) {
    const name = String(object.name); expect(name).toMatch(/^[a-z][a-z0-9_]*$/u);
    image[name] = safeRows(await s.f.exec(object.kind === 'S' ? `SELECT last_value,is_called FROM public."${name}"`
      : `SELECT to_jsonb(t) AS row FROM public."${name}" t ORDER BY to_jsonb(t)::text`)).sort(rowOrder);
  }
  return image;
}
async function readOnly<T>(h: Harness, work: () => Promise<T>) {
  const before = await snapshot(h.s), writes = h.writes.length;
  try { return await work(); }
  finally { expect(await snapshot(h.s)).toEqual(before); expect(h.writes.slice(writes)).toEqual([]); }
}
async function configure(s: Buyer, values: Record<string, string>) {
  for (const [menuName, value] of Object.entries(values)) {
    const changed = await s.f.db.update(systemConfig).set({ value }).where(and(eq(systemConfig.menuName, menuName), eq(systemConfig.isStore, 0))).returning({ id: systemConfig.id });
    if (!changed.length) await s.f.db.insert(systemConfig).values({ menuName, value, isStore: 0 });
  }
}
async function prepare(s: Buyer): Promise<Harness> {
  expect(s.f.format).toBe('pg16');
  const [identity] = await s.appContainer.db.execute(sql`SELECT current_user AS role,session_user AS session`);
  expect(identity).toEqual({ role: s.appRole, session: s.appRole });
  const [role] = await s.f.exec(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls FROM pg_roles WHERE rolname='${s.appRole}'`);
  expect(role).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolbypassrls: false });
  await s.f.db.delete(storeCart);
  await s.f.db.update(storeCouponIssue).set({ status: 0 });
  await s.f.db.update(user).set({ status: 1, isDel: 0, deleteTime: null, isEverLevel: 0, isMoneyLevel: 0,
    overdueTime: 0, level: 0, levelStatus: 0, isFirstOrder: 0, addTime: Math.floor(Date.now() / 1_000) });
  await configure(s, { member_func_status: '0', member_card_status: '0', svip_price_status: '0', newcomer_status: '0',
    first_order_status: '0', newcomer_limit_status: '0', newcomer_limit_time: '0', first_order_discount: '85.99',
    first_order_discount_limit: '100.00', integral_ratio_status: '0', store_func_status: '1', store_self_mention: '1' });
  await s.f.db.update(storeProduct).set({ type: 0, relationId: 0, pid: 0, productType: 0, price: '19.99', vipPrice: '10.00',
    stock: 8, isShow: 1, isDel: 0, isVerify: 1, isVip: 1, isVipProduct: 0, isPresaleProduct: 0,
    image: '', sliderImage: '[]', freight: 1, tempId: 0, cateId: '', brandId: 0, giveIntegral: '0.00', isSub: 0 }).where(eq(storeProduct.id, 70));
  await s.f.db.update(storeProductAttrValue).set({ productId: 70, type: 0, unique: 'qared001', suk: '红色,大号',
    price: '19.99', vipPrice: '10.00', otPrice: '25.00', stock: 8, productType: 0, isRetired: 0, image: '' }).where(eq(storeProductAttrValue.id, 1));
  const h: Harness = { s, writes: [], stale: new Map(), allowCheckoutKv: false }, original = s.env.CONFIG_KV;
  Object.assign(s.env, {
    CONFIG_KV: { get: async (key: string, type?: string) => h.stale.has(key)
      ? type === 'json' ? JSON.parse(h.stale.get(key)!) : h.stale.get(key)! : original.get(key, type as 'text'),
    put: async (key: string, value: string, options?: KVNamespacePutOptions) => {
      h.writes.push({ operation: 'put', key }); if (!h.allowCheckoutKv) throw Error('Estimate must not write KV');
      await original.put(key, value, options);
    }, delete: async (key: string) => { h.writes.push({ operation: 'delete', key }); throw Error('Estimate must not delete KV'); } },
    SEQUENCE: { idFromName: () => { h.writes.push({ operation: 'sequence' }); throw Error('Estimate must not allocate an ID'); },
      get: () => { h.writes.push({ operation: 'sequence' }); throw Error('Estimate must not allocate an ID'); } },
    ORDER_QUEUE: { send: async () => { h.writes.push({ operation: 'queue' }); throw Error('Estimate must not enqueue'); },
      sendBatch: async () => { h.writes.push({ operation: 'queue' }); throw Error('Estimate must not enqueue'); } },
  });
  return h;
}
async function good(h: Harness, path = PATH, bearer?: string | null): Promise<PublicProductEstimate> {
  const reply = await h.s.request(path, undefined, bearer);
  expect(reply.status, `${path}: ${reply.msg}`).toBe(200); expect(reply.httpStatus).toBe(200);
  expect(reply.headers.get('Cache-Control')).toBe('private, no-store');
  expect(reply.headers.get('Pragma')).toBe('no-cache'); expect(reply.headers.get('Referrer-Policy')).toBe('no-referrer');
  const value = reply.data as PublicProductEstimate;
  expect(decodePublicProductEstimate(value, { ownerUid: value.ownerUid, productId: 70, skuUnique: value.skuUnique })).toEqual(value);
  expect(value).not.toHaveProperty('orderKey'); expect(value).not.toHaveProperty('quoteToken');
  expect(value).toMatchObject({ version: 1, view: 'uni_product_estimate_v1', quantity: 1,
    excludes: ['shipping', 'integral', 'payment'], requiresCheckoutRequote: true });
  return value;
}
async function bad(h: Harness, path = PATH, bearer?: string | null) {
  const reply = await h.s.request(path, undefined, bearer);
  expect(reply.status, path).not.toBe(200); expect(reply.data).toBeNull();
  expect(reply.headers.get('Cache-Control')).toBe('private, no-store'); expect(reply.headers.get('Pragma')).toBe('no-cache');
  return reply;
}
async function issue(s: Buyer, id: number, fields: Partial<typeof storeCouponIssue.$inferInsert> = {}) {
  await s.f.db.insert(storeCouponIssue).values({ id, category: 1, couponType: 0, type: 1, title: `本机可领${id}`, couponTitle: `本机可领${id}`,
    couponPrice: '1.00', useMinPrice: '0.00', receiveType: 1, receiveLimit: 1, totalCount: 100, remainCount: 100, day: 7, status: 1, ...fields });
}
async function promotion(s: Buyer, overlay = '5') {
  const now = Math.floor(Date.now() / 1_000);
  await s.f.db.insert(storePromotions).values({ id: ID, name: '实际限时九折', promotionsType: 1, type: 1,
    pid: 0, storeId: 0, status: 1, isDel: 0, startTime: now - 3600, stopTime: now + 3600,
    discount: '90', productPartakeType: 1, isLimit: 0, overlay });
}
async function blockedAtCouponRead(s: Buyer, lockerPid: number) {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    const [row] = await s.f.exec(`SELECT wait_event_type AS wait,query,${lockerPid}=ANY(pg_blocking_pids(pid)) AS blocked
      FROM pg_stat_activity WHERE pid=${s.appPid}`);
    if (row?.wait === 'Lock' && row.blocked === true && String(row.query).includes('store_coupon_issue')) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Actual App did not reach the controlled coupon SQL lock');
}
function changedSnapshot(before: Record<string, unknown>, edits: Array<{ table: string; id: number; field: string; value: unknown }>) {
  const expected = structuredClone(before);
  for (const edit of edits) {
    const rows = safeRows(expected[edit.table]);
    const entry = rows.find(entry => entry.row && typeof entry.row === 'object'
      && (entry.row as Record<string, unknown>)[edit.table === 'user' ? 'uid' : 'id'] === edit.id);
    if (!entry) throw Error('Controlled owner mutation target missing from complete snapshot');
    (entry.row as Record<string, unknown>)[edit.field] = edit.value;
  }
  for (const table of new Set(edits.map(edit => edit.table))) safeRows(expected[table]).sort(rowOrder);
  return expected;
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('public no-cart estimate through actual App and commissioned PG16 LOGIN', () => {
  it('keeps anonymous and A/B ownership separate and preserves older issued terms instead of mutable face or latest used ownership', async () => withBuyerInvoices(async s => {
    const h = await prepare(s);
    await issue(s, ID, { couponPrice: '2.00', useMinPrice: '100.00' });
    await s.f.db.insert(storeCouponUser).values([
      { id: ID + 101, uid: 11, issueCouponId: ID, couponTitle: '本人原发行快照', couponPrice: '4.00', useMinPrice: '19.99', receiveTime: 1 },
      { id: ID + 102, uid: 11, issueCouponId: ID, couponTitle: '较新但已使用', couponPrice: '9.00', useMinPrice: '0.00', receiveTime: 10, status: 1 },
      { id: ID + 103, uid: 22, issueCouponId: ID, couponTitle: '另一账号的券', couponPrice: '8.00', useMinPrice: '0.00' },
    ]);
    const other = await s.token(22);
    await readOnly(h, async () => {
      expect((await good(h, PATH, null))).toMatchObject({ ownerUid: 0, computed: { coupon: null, deduction: { pay_price: '19.99' } } });
      expect((await good(h))).toMatchObject({ ownerUid: 11, computed: { coupon: { source: 'owned', issueId: ID,
        ownedId: ID + 101, requiresClaim: false, title: '本人原发行快照', benefitValue: '4.00', minimum: '19.99', savings: '4.00' } } });
      expect((await good(h, PATH, other))).toMatchObject({ ownerUid: 22, computed: { coupon: { ownedId: ID + 103, savings: '8.00' } } });
      expect(JSON.stringify(await good(h))).not.toContain('另一账号');
    });
    expect(await s.f.db.select().from(storeCart)).toEqual([]);
  }), 120_000);

  it('selects greatest real saving beyond decorative first3 and first50 and resolves stable owned/issue ties', async () => withBuyerInvoices(async s => {
    const h = await prepare(s);
    await s.f.db.insert(storeCouponIssue).values(Array.from({ length: 60 }, (_, i) => ({ id: ID + i, category: 1, couponType: 0, type: 2,
      title: '高面值低实际节省候选', couponTitle: '高面值低实际节省候选', couponPrice: '95.00', sort: 100,
      receiveType: 1, receiveLimit: 1, totalCount: 2, remainCount: 2, day: 7, status: 1 })));
    await issue(s, ID + 60, { type: 2, couponPrice: '85.99' });
    await issue(s, ID + 61, { type: 2, couponPrice: '95.00' });
    await readOnly(h, async () => {
      const decoration = await s.request('/api/product/detail/activity/70');
      expect(decoration.status, decoration.msg).toBe(200); expect(decoration.data.coupons).toHaveLength(3);
      expect(decoration.data.coupons.map((row: { id: number }) => row.id)).not.toContain(ID + 60);
      const page = await s.request('/api/product/detail/70/coupons?view=uni_product_coupons&page=1&limit=50');
      expect(page.status, page.msg).toBe(200); expect(page.data.items).toHaveLength(50);
      expect(page.data.items.map((row: { id: number }) => row.id)).not.toContain(ID + 60);
      expect((await good(h))).toMatchObject({ computed: { coupon: { source: 'issue', issueId: ID + 60,
        ownedId: null, requiresClaim: true, benefitValue: '85.99', savings: '3.00' }, deduction: { pay_price: '16.99' } } });
    });
    await issue(s, ID + 62, { couponPrice: '3.00' });
    await s.f.db.insert(storeCouponUser).values([{ id: ID + 201, uid: 11, issueCouponId: ID + 62, couponPrice: '3.00' },
      { id: ID + 202, uid: 11, issueCouponId: ID + 62, couponPrice: '3.00' }]);
    await readOnly(h, async () => expect((await good(h)).computed.coupon).toMatchObject({ source: 'owned', ownedId: ID + 201, savings: '3.00' }));
    await s.f.db.update(storeCouponUser).set({ status: 1 });
    await readOnly(h, async () => expect((await good(h)).computed.coupon).toMatchObject({ source: 'issue', issueId: ID + 60 }));
  }), 120_000);

  it('uses genuine ordinary claim window, inventory, title, validity and lifetime history admission without claiming', async () => withBuyerInvoices(async s => {
    const h = await prepare(s), now = Date.now();
    const variants: Array<Partial<typeof storeCouponIssue.$inferInsert>> = [
      { category: 3 }, { receiveType: 2 }, { appType: 1 }, { status: 0 }, { isDel: 1 }, { remainCount: 0 },
      { receiveLimit: -1 }, { startTime: new Date(now + 86_400_000) }, { endTime: new Date(now - 86_400_000) },
      { day: 0 }, { day: 0, useEndTime: new Date(now - 1) },
      { day: 0, useStartTime: new Date(now + 86_400_000), useEndTime: new Date(now + 172_800_000) },
      { day: 2_147_483_647 }, { couponTitle: '券'.repeat(65) }, { receiveLimit: 0 }, { receiveLimit: 1 },
    ];
    for (let i = 0; i < variants.length; i++) await issue(s, ID + i, { couponPrice: '19.99', ...variants[i] });
    await s.f.db.insert(storeCouponIssueUser).values({ uid: 11, issueCouponId: ID + 14 });
    await s.f.db.insert(storeCouponUser).values({ uid: 11, issueCouponId: ID + 15, status: 3, couponPrice: '19.99' });
    await issue(s, ID + 100, { category: 0, receiveLimit: 0, isPermanent: 1, totalCount: 0, remainCount: 0, couponPrice: '1.00' });
    await readOnly(h, async () => expect((await good(h)).computed.coupon).toMatchObject({ issueId: ID + 100, requiresClaim: true, savings: '1.00' }));
    await s.f.db.insert(storeCouponIssueUser).values({ uid: 11, issueCouponId: ID + 100 });
    await readOnly(h, async () => expect((await good(h)).computed.coupon).toBeNull());
    await s.f.db.update(storeCouponIssue).set({ receiveLimit: 2 }).where(eq(storeCouponIssue.id, ID + 100));
    await readOnly(h, async () => expect((await good(h)).computed.coupon).toMatchObject({ issueId: ID + 100 }));
  }), 120_000);

  it.each(['owned', 'issue'] as const)('rejects a complete-source overflow above 1000 %s candidates without partial winners', async source => withBuyerInvoices(async s => {
    const h = await prepare(s);
    if (source === 'owned') {
      await issue(s, ID);
      await s.f.db.insert(storeCouponUser).values(Array.from({ length: 1_001 }, (_, n) => ({ id: ID + 10_000 + n, uid: 11,
        issueCouponId: ID, couponTitle: '完整所有权集合', couponPrice: '1.00' })));
    } else await s.f.db.insert(storeCouponIssue).values(Array.from({ length: 1_001 }, (_, n) => ({ id: ID + n, category: 1,
      couponType: 0, type: 1, couponTitle: '完整可领集合', title: '完整可领集合', couponPrice: '1.00', receiveType: 1,
      receiveLimit: 1, totalCount: 2, remainCount: 2, day: 7, status: 1 })));
    await readOnly(h, async () => expect((await bad(h)).msg).toContain('读取上限'));
  }), 120_000);

  it('uses actual direct/parent/category/brand scopes, exact threshold and post-promotion coupon overlays', async () => withBuyerInvoices(async s => {
    const h = await prepare(s);
    await s.f.db.insert(storeProduct).values({ id: 60, type: 0, relationId: 0, pid: 0, productType: 0,
      storeName: '真实平台父商品', price: '19.99', stock: 8, isShow: 1, isDel: 0, isVerify: 1 });
    await s.f.db.update(storeProduct).set({ type: 2, relationId: 7, pid: 60, cateId: '102', brandId: 22 }).where(eq(storeProduct.id, 70));
    await s.f.db.insert(storeProductCategory).values({ id: 102, pid: 101, path: '100,101', cateName: '实际后代分类' });
    await s.f.db.insert(storeBrand).values({ id: 22, pid: 21, fid: '20,21', brandName: '实际后代品牌' });
    await issue(s, ID, { couponType: 2, productId: '70', couponPrice: '1.00' });
    await issue(s, ID + 1, { couponType: 2, productId: '60', couponPrice: '2.00' });
    await s.f.db.insert(storeCouponProduct).values({ couponId: ID + 1, productId: 60 });
    await issue(s, ID + 2, { couponType: 1, legacyCategoryId: 100, couponPrice: '3.00' });
    await issue(s, ID + 3, { couponType: 3, legacyBrandId: 20, couponPrice: '4.00', useMinPrice: '19.99' });
    await issue(s, ID + 4, { couponPrice: '19.99', useMinPrice: '20.00' });
    for (const [disabled, winner, saving] of [[-1, ID + 3, '4.00'], [ID + 3, ID + 2, '3.00'], [ID + 2, ID + 1, '2.00']] as const) {
      if (disabled > 0) await s.f.db.update(storeCouponIssue).set({ status: 0 }).where(eq(storeCouponIssue.id, disabled));
      await readOnly(h, async () => expect((await good(h)).computed.coupon).toMatchObject({ issueId: winner, savings: saving }));
    }
    await s.f.db.update(storeCouponProduct).set({ productId: 999 }).where(eq(storeCouponProduct.couponId, ID + 1));
    await readOnly(h, async () => expect((await good(h)).computed.coupon).toMatchObject({ issueId: ID, savings: '1.00' }));
    // Type-1 promotion floors the saving: floor(19.99 * 10%) = 1.99.
    // Coupon subtraction has a separate PHP convention and is not reused here.
    await promotion(s);
    await readOnly(h, async () => {
      const result = await good(h);
      expect(result.computed.promotions).toEqual([{ id: ID, type: 1, name: '实际限时九折', savings: '1.99', quantity: 1 }]);
      expect(result.computed.deduction).toMatchObject({ sum_price: '19.99', promotions_price: '1.99', coupon_price: '1.00', pay_price: '17.00' });
    });
    await s.f.db.update(storePromotions).set({ overlay: '' }).where(eq(storePromotions.id, ID));
    await readOnly(h, async () => expect((await good(h)).computed).toMatchObject({ coupon: null, deduction: { coupon_price: '0.00', pay_price: '18.00' } }));
  }), 120_000);

  it('uses real membership coupon eligibility, current rights and no historical receipt rather than category alone', async () => withBuyerInvoices(async s => {
    const h = await prepare(s), now = Math.floor(Date.now() / 1_000);
    await issue(s, ID, { category: 2, couponPrice: '5.00' });
    await s.f.db.insert(memberRight).values({ id: ID, rightType: 'coupon', number: 1, status: 1 });
    await configure(s, { member_card_status: '1' });
    await readOnly(h, async () => {
      expect((await good(h, PATH, null)).computed.coupon).toBeNull();
      expect((await good(h)).computed.coupon).toBeNull();
    });
    await s.f.db.update(user).set({ isMoneyLevel: 1, overdueTime: now + 3600 }).where(eq(user.uid, 11));
    await readOnly(h, async () => expect((await good(h)).computed.coupon).toMatchObject({ source: 'issue', issueId: ID, isMember: true, savings: '5.00' }));
    await s.f.db.update(memberRight).set({ status: 0 }).where(eq(memberRight.id, ID));
    await readOnly(h, async () => expect((await good(h)).computed.coupon).toBeNull());
    await s.f.db.update(memberRight).set({ status: 1 }).where(eq(memberRight.id, ID));
    await s.f.db.update(user).set({ overdueTime: now - 1 }).where(eq(user.uid, 11));
    await readOnly(h, async () => expect((await good(h)).computed.coupon).toBeNull());
    await s.f.db.update(user).set({ isEverLevel: 1 }).where(eq(user.uid, 11));
    await configure(s, { member_card_status: '0' });
    await readOnly(h, async () => expect((await good(h)).computed.coupon).toBeNull());
    await configure(s, { member_card_status: '1' });
    await s.f.db.insert(storeCouponIssueUser).values({ uid: 11, issueCouponId: ID });
    await readOnly(h, async () => expect((await good(h)).computed.coupon).toBeNull());
    await s.f.db.delete(storeCouponIssueUser).where(eq(storeCouponIssueUser.issueCouponId, ID));
    await s.f.db.insert(storeCouponUser).values({ uid: 11, issueCouponId: ID, status: 1, couponPrice: '5.00' });
    await readOnly(h, async () => expect((await good(h)).computed.coupon).toBeNull());
  }), 120_000);

  it('uses membership SQL switches, level integer truncation, live paid price and expiry without stale KV authority', async () => withBuyerInvoices(async s => {
    const h = await prepare(s);
    await s.f.db.insert(systemUserLevel).values({ id: ID, name: '真实银卡', discount: '88.50', isShow: 1, isDel: 0 });
    await s.f.db.update(user).set({ level: ID, levelStatus: 1 }).where(eq(user.uid, 11));
    await configure(s, { member_func_status: '1', member_card_status: '1', svip_price_status: '1' });
    h.stale.set('cfg_member_func_status', '0'); h.stale.set('cfg_member_card_status', '0'); h.stale.set('cfg_svip_price_status', '0');
    await readOnly(h, async () => expect((await good(h)).computed.deduction).toMatchObject({ vip_price: '2.40', pay_price: '17.59' }));
    await s.f.db.update(user).set({ isMoneyLevel: 1, overdueTime: Math.floor(Date.now() / 1_000) + 3600 }).where(eq(user.uid, 11));
    await readOnly(h, async () => expect((await good(h)).computed.deduction).toMatchObject({ vip_price: '9.99', pay_price: '10.00' }));
    await configure(s, { svip_price_status: '0' });
    await readOnly(h, async () => expect((await good(h)).computed.deduction.pay_price).toBe('17.59'));
    await configure(s, { svip_price_status: '1' });
    await s.f.db.update(user).set({ overdueTime: Math.floor(Date.now() / 1_000) - 1 }).where(eq(user.uid, 11));
    await readOnly(h, async () => expect((await good(h)).computed.deduction.pay_price).toBe('17.59'));
    await configure(s, { member_func_status: '0' });
    await readOnly(h, async () => expect((await good(h)).computed.deduction).toMatchObject({ vip_price: '0.00', pay_price: '19.99' }));
    await s.f.db.update(storeProduct).set({ isVipProduct: 1 }).where(eq(storeProduct.id, 70));
    await readOnly(h, async () => { await bad(h); await bad(h, PATH, null); });
  }), 120_000);

  it('uses SQL first-order 2.99 and zero-saving exclusivity and ignores paid newcomer type7 history', async () => withBuyerInvoices(async s => {
    const h = await prepare(s);
    await configure(s, { newcomer_status: '1', first_order_status: '1', first_order_discount: '85.99',
      first_order_discount_limit: '100.00', newcomer_limit_status: '0' });
    h.stale.set('cfg_newcomer_status', '0'); h.stale.set('cfg_first_order_status', '0');
    await issue(s, ID, { type: 2, couponPrice: '85.99' }); await promotion(s);
    await s.f.db.insert(storeOrder).values({ id: ID, uid: 11, orderId: 'public_estimate_newcomer_paid', unique: 'public_estimate_newcomer_paid', paid: 1, type: 7 });
    await readOnly(h, async () => expect(await good(h)).toMatchObject({ firstOrderEligible: true,
      computed: { coupon: null, promotions: [], deduction: { first_order_price: '2.99', coupon_price: '0.00', promotions_price: '0.00', pay_price: '17.00' } } }));
    await configure(s, { first_order_discount: '100' });
    await readOnly(h, async () => expect(await good(h)).toMatchObject({ firstOrderEligible: true,
      computed: { coupon: null, promotions: [], deduction: { first_order_price: '0.00', coupon_price: '0.00', promotions_price: '0.00', pay_price: '19.99' } } }));
    await s.f.db.update(storeOrder).set({ type: 0 }).where(eq(storeOrder.id, ID));
    await readOnly(h, async () => expect(await good(h)).toMatchObject({ firstOrderEligible: false,
      computed: { deduction: { first_order_price: '0.00', promotions_price: '1.99', coupon_price: '2.70', pay_price: '15.30' } } }));
  }), 120_000);

  it('chooses the lowest raw SKU before benefits with stable ID ties and handles explicit, retired, unavailable and duplicate identity', async () => withBuyerInvoices(async s => {
    const h = await prepare(s);
    await s.f.db.insert(storeProductAttrValue).values([{ id: 91, productId: 70, unique: 'qablue01', suk: '蓝色', price: '10.01', vipPrice: '9.00', stock: 8 },
      { id: 90, productId: 70, unique: 'qagreen1', suk: '绿色', price: '10.01', vipPrice: '8.00', stock: 8 }]);
    await readOnly(h, async () => {
      expect(await good(h, BASE)).toMatchObject({ skuUnique: 'qagreen1', computed: { deduction: { sum_price: '10.01', pay_price: '10.01' } } });
      expect(await good(h)).toMatchObject({ skuUnique: 'qared001', computed: { deduction: { sum_price: '19.99' } } });
      expect(await good(h, BASE + '&unique=qablue01')).toMatchObject({ skuUnique: 'qablue01' });
      await bad(h, BASE + '&unique=missing1');
    });
    await s.f.db.update(storeProductAttrValue).set({ vipPrice: '1.00' }).where(eq(storeProductAttrValue.id, 1));
    await s.f.db.update(user).set({ isEverLevel: 1 }).where(eq(user.uid, 11));
    await configure(s, { member_card_status: '1', svip_price_status: '1' });
    await readOnly(h, async () => {
      expect(await good(h, BASE)).toMatchObject({ skuUnique: 'qagreen1', computed: { deduction: { sum_price: '10.01', pay_price: '8.00' } } });
      expect(await good(h)).toMatchObject({ skuUnique: 'qared001', computed: { deduction: { sum_price: '19.99', pay_price: '1.00' } } });
    });
    await s.f.db.update(storeProductAttrValue).set({ stock: 0 }).where(eq(storeProductAttrValue.id, 90));
    await readOnly(h, async () => { await bad(h, BASE); expect((await good(h)).skuUnique).toBe('qared001'); });
    await s.f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.id, 90));
    await readOnly(h, async () => { expect((await good(h, BASE)).skuUnique).toBe('qablue01'); await bad(h, BASE + '&unique=qagreen1'); });
    await s.f.db.insert(storeProductAttrValue).values({ id: 92, productId: 70, unique: 'qablue01', suk: '另一蓝色', price: '10.01', stock: 8 });
    await readOnly(h, async () => { await bad(h, BASE); await bad(h); });
  }), 120_000);

  it('preserves a genuine SQL zero price while rejecting invalid negative SKU price and invalid public ownership', async () => withBuyerInvoices(async s => {
    const h = await prepare(s);
    await s.f.db.update(storeProductAttrValue).set({ price: '0.00' }).where(eq(storeProductAttrValue.id, 1));
    await readOnly(h, async () => expect((await good(h)).computed).toMatchObject({ coupon: null, promotions: [],
      deduction: { sum_price: '0.00', vip_price: '0.00', coupon_price: '0.00', pay_price: '0.00' } }));
    await s.f.db.update(storeProductAttrValue).set({ price: '-0.01' }).where(eq(storeProductAttrValue.id, 1));
    await readOnly(h, async () => await bad(h));
    await s.f.db.update(storeProductAttrValue).set({ price: 'NaN' }).where(eq(storeProductAttrValue.id, 1));
    await readOnly(h, async () => await bad(h));
    await s.f.db.update(storeProductAttrValue).set({ price: '19.99' }).where(eq(storeProductAttrValue.id, 1));
    for (const change of [{ isShow: 0 }, { isVerify: 0 }, { isDel: 1 }, { isPresaleProduct: 1 }]) {
      await s.f.db.update(storeProduct).set(change).where(eq(storeProduct.id, 70));
      await readOnly(h, async () => await bad(h));
      await s.f.db.update(storeProduct).set({ isShow: 1, isVerify: 1, isDel: 0, isPresaleProduct: 0 }).where(eq(storeProduct.id, 70));
    }
    await s.f.db.update(storeProduct).set({ type: 1, relationId: 1 }).where(eq(storeProduct.id, 70));
    await s.f.db.update(systemStore).set({ isShow: 0 }).where(eq(systemStore.id, 1));
    await readOnly(h, async () => await bad(h));
    await s.f.db.update(storeProduct).set({ type: 2, relationId: 7 }).where(eq(storeProduct.id, 70));
    await s.f.db.update(systemSupplier).set({ isShow: 0 }).where(eq(systemSupplier.id, 7));
    await readOnly(h, async () => await bad(h));
    await s.f.db.update(systemSupplier).set({ isShow: 1 }).where(eq(systemSupplier.id, 7));
    await s.f.db.insert(storeProduct).values({ id: 60, type: 0, relationId: 0, pid: 0, productType: 0,
      storeName: '真实隐藏父商品', price: '19.99', stock: 8, isShow: 0, isDel: 0, isVerify: 1 });
    await s.f.db.update(storeProduct).set({ pid: 60 }).where(eq(storeProduct.id, 70));
    await readOnly(h, async () => await bad(h));
  }), 120_000);

  it('keeps the legacy activity envelope while strict opt-in query and real invalid JWT requests remain private and unwritten', async () => withBuyerInvoices(async s => {
    const h = await prepare(s), token = await s.token();
    const expired = (await createToken(11, 'api', md5(''), s.env.APP_KEY, 'cinashop', Math.floor(Date.now() / 1_000) - 9 * 86_400)).token;
    const wrongActorType = (await createToken(11, 'admin', md5(''), s.env.APP_KEY)).token;
    await readOnly(h, async () => {
      const legacy = await s.request('/api/product/detail/activity/70', undefined, null);
      expect(legacy.status, legacy.msg).toBe(200); expect(legacy.data.computed).toEqual({ deduction: [] });
      expect(legacy.data).not.toHaveProperty('version'); expect(legacy.data).not.toHaveProperty('ownerUid');
      for (const suffix of ['&uid=22', '&amount=0', '&quantity=2', '&cartId=1', '&couponId=1', '&quoteToken=x',
        '&promotions_type=1', '&unique=qared001&unique=qablue01', '&unique=', '&unique=abc%20',
        '&view=uni_product_estimate_v1', '&unique=123456789']) await bad(h, BASE + suffix);
      for (const path of ['/api/product/detail/activity/070?view=uni_product_estimate_v1', '/api/product/detail/activity/2147483648?view=uni_product_estimate_v1',
        '/api/product/detail/activity/70?view=unknown', '/api/product/detail/activity/%37%30?view=uni_product_estimate_v1']) await bad(h, path);
      for (const bearer of ['malformed', token.slice(0, -8) + 'invalid', expired, wrongActorType]) await bad(h, PATH, bearer);
    });
    for (const state of [{ pwd: 'changed-password' }, { status: 0 }, { isDel: 1 }, { deleteTime: new Date() }]) {
      const [original] = await s.f.db.select().from(user).where(eq(user.uid, 11));
      await s.f.db.update(user).set(state).where(eq(user.uid, 11));
      await readOnly(h, async () => await bad(h, PATH, token));
      await s.f.db.update(user).set({ pwd: original.pwd, status: original.status, isDel: original.isDel, deleteTime: original.deleteTime }).where(eq(user.uid, 11));
    }
  }), 120_000);

  it('compares an owned estimate with actual checkout quoting of the same real SKU and quantity without using advisory values as authority', async () => withBuyerInvoices(async s => {
    const h = await prepare(s);
    await issue(s, ID, { type: 2, couponPrice: '50.00' });
    await s.f.db.insert(storeCouponUser).values({ id: ID + 100, uid: 11, issueCouponId: ID, couponPrice: '85.99', useMinPrice: '0.00', type: 2 });
    const advisory = await readOnly(h, () => good(h));
    expect(advisory.computed.coupon).toMatchObject({ source: 'owned', ownedId: ID + 100, savings: '3.00' });
    await s.f.db.insert(storeCart).values({ id: ID + 200, uid: 11, productId: 70, productAttrUnique: 'qared001', cartNum: 1, isNew: 1, status: 1 });
    // Checkout is a distinct protocol with its existing KV quote writes. This
    // comparison uses only actual selection IDs, never advisory money/tokens.
    h.allowCheckoutKv = true;
    const selection = { uid: 11, cartIds: [ID + 200], type: 0, addressId: 11, shippingType: 1, storeId: 0, couponId: ID + 100, useIntegral: false };
    const before = await snapshot(s), quote = await new StoreOrderCreateService(s.appContainer, s.env).quoteOrder(selection);
    expect(await snapshot(s)).toEqual(before);
    expect(quote.couponPriceCents).toBe(300); expect(quote.payCents).toBe(1699);
    expect(advisory.computed.deduction).toMatchObject({ sum_price: '19.99', coupon_price: '3.00', pay_price: '16.99' });
    expect(h.writes.every(write => write.operation === 'put')).toBe(true);
  }), 120_000);

  it('uses one actual repeatable-read snapshot when a concurrent SQL writer changes SKU and coupon during its blocked read', async () => withBuyerInvoices(async s => {
    const h = await prepare(s); await issue(s, ID);
    if (!s.f.withPeer) throw Error('Native independent owner peer required');
    const before = await snapshot(s);
    await s.f.withPeer(async peer => {
      await peer.exec('BEGIN'); let committed = false;
      try {
        await peer.exec('LOCK TABLE public.store_coupon_issue IN ACCESS EXCLUSIVE MODE');
        const pending = s.request(PATH); void pending.catch(() => {});
        await blockedAtCouponRead(s, peer.pid);
        await s.f.db.update(storeProductAttrValue).set({ price: '29.99' }).where(eq(storeProductAttrValue.id, 1));
        await peer.db.update(storeCouponIssue).set({ couponPrice: '5.00' }).where(eq(storeCouponIssue.id, ID));
        await peer.exec('COMMIT'); committed = true;
        const reply = await pending; expect(reply.status, reply.msg).toBe(200);
        expect(reply.data).toMatchObject({ computed: { coupon: { savings: '1.00' }, deduction: { sum_price: '19.99', pay_price: '18.99' } } });
      } finally { if (!committed) await peer.exec('ROLLBACK'); }
    });
    expect(await snapshot(s)).toEqual(changedSnapshot(before, [
      { table: 'store_product_attr_value', id: 1, field: 'price', value: 29.99 },
      { table: 'store_coupon_issue', id: ID, field: 'coupon_price', value: 5 },
    ]));
    expect(h.writes).toEqual([]);
    await readOnly(h, async () => expect((await good(h)).computed).toMatchObject({ coupon: { savings: '5.00' }, deduction: { sum_price: '29.99', pay_price: '24.99' } }));
  }), 120_000);

  it('rechecks the real actor after the snapshot and rejects a concurrent password or status change before releasing private output', async () => withBuyerInvoices(async s => {
    const h = await prepare(s); await issue(s, ID);
    if (!s.f.withPeer) throw Error('Native independent owner peer required');
    for (const mutation of [{ pwd: 'changed-during-private-estimate' }, { status: 0 }]) {
      const token = await s.token(), [original] = await s.f.db.select().from(user).where(eq(user.uid, 11));
      const before = await snapshot(s);
      await s.f.withPeer(async peer => {
        await peer.exec('BEGIN'); let committed = false;
        try {
          await peer.exec('LOCK TABLE public.store_coupon_issue IN ACCESS EXCLUSIVE MODE');
          const pending = s.request(PATH, undefined, token); void pending.catch(() => {});
          await blockedAtCouponRead(s, peer.pid);
          await s.f.db.update(user).set(mutation).where(eq(user.uid, 11));
          await peer.exec('COMMIT'); committed = true;
          const reply = await pending; expect(reply.status).not.toBe(200); expect(reply.data).toBeNull();
          expect(reply.headers.get('Cache-Control')).toBe('private, no-store');
        } finally { if (!committed) await peer.exec('ROLLBACK'); }
      });
      const [field, value] = Object.entries(mutation)[0];
      expect(await snapshot(s)).toEqual(changedSnapshot(before, [{ table: 'user', id: 11, field, value }]));
      expect(h.writes).toEqual([]);
      await s.f.db.update(user).set({ pwd: original.pwd, status: original.status }).where(eq(user.uid, 11));
    }
  }), 120_000);

  it('fails an actual SQL lock timeout without returning zero or partial-price advice', async () => withBuyerInvoices(async s => {
    const h = await prepare(s); await issue(s, ID);
    if (!s.f.withPeer) throw Error('Native independent owner peer required');
    await readOnly(h, async () => {
      await s.f.withPeer(async peer => {
        await peer.exec('BEGIN');
        try {
          await peer.exec('LOCK TABLE public.store_coupon_issue IN ACCESS EXCLUSIVE MODE');
          await bad(h);
        } finally { await peer.exec('ROLLBACK'); }
      });
    });
  }), 120_000);
});
