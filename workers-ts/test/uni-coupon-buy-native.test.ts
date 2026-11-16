import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { storeCart, storeCouponIssue, storeCouponIssueUser, storeCouponUser, storeOrder, storeOrderCartInfo,
  storeProduct, storeProductAttrValue, systemAttachment, user, userBill } from '@/models/schema';
import { withBuyerInvoices } from './helpers/buyerInvoices';
import { buyerReviewPng, buyerReviewR2 } from './helpers/buyerReviewR2';
import { StoreCartService } from '@/services/order/StoreCartService';
import { projectOrderPictures } from '@/services/order/OrderPictureProjection';
import { normalizeOrderCouponPage, orderCouponScope } from '../../view/common/orderCoupons';
import { validateCheckoutItems } from '../../view/common/checkoutSelection';
import { ProductCouponBuyJournal, productCouponBuyKey, type ProductCouponBuyIntent } from '../../view/common/productCouponBuyIntent';
import { ProductCouponBuyPreselection, parseProductCouponBuySelection } from '../../view/common/productCouponBuyPreselection';

type S = Parameters<Parameters<typeof withBuyerInvoices>[0]>[0];
type KvEvent = { operation: 'put' | 'delete'; key: string; ttl?: number };
type H = { s: S; events: KvEvent[]; calls: { path: string; body?: unknown; bearer?: string | null }[]; request: S['request'] };
const issueId = 954000, otherIssueId = 954001, expiredIssueId = 954002;
const directory = '/api/product/detail/70/coupons?view=uni_product_coupons';
const receipt = (id = issueId) => `/api/product/detail/70/coupons/${id}/receipt`;
const picker = (cartId: number) => `/api/coupons/order/0?cartId=${cartId}&new=1&shipping_type=1&store_id=0&limit=20`;

async function setup(s: S): Promise<H> {
  expect(s.f.format).toBe('pg16');
  const [identity] = await s.appContainer.db.execute(sql`SELECT current_user AS role, pg_backend_pid() AS pid`);
  expect(identity).toMatchObject({ role: s.appRole, pid: s.appPid });
  const [role] = await s.f.exec(`SELECT rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname='${s.appRole}'`);
  expect(role).toMatchObject({ rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false });
  await s.f.db.update(storeCouponIssue).set({ status: 0 });
  await s.f.db.insert(storeCouponIssue).values([issueId, otherIssueId, expiredIssueId].map(id => ({ id,
    couponTitle: `本机完整领券购买 ${id}`, title: '本机完整领券购买', category: 0, couponType: 2, productId: id === otherIssueId ? '71' : '70',
    type: 1, couponPrice: '5.00', useMinPrice: '10.00', day: 7, status: 1, receiveType: 1, appType: 0,
    receiveLimit: id === issueId ? 2 : 1, totalCount: 5, remainCount: 5, sort: 1000 - (id - issueId), rule: '<p>原购物车与真实订单筛券为准</p>' })));
  // The shared fixture explicitly owns cart IDs 1/2. Advance only this local
  // fixture sequence before the first real cart POST, never repair business SQL.
  await s.f.exec("SELECT setval('public.store_cart_id_seq',(SELECT max(id) FROM public.store_cart),true)");
  let number = 0;
  // A local identifier adapter only. Grant, cart, quote, pricing, reserve and
  // cancellation below are the actual App/UserJWT/commissioned LOGIN paths.
  Object.assign(s.env, { SEQUENCE: { idFromName: () => 'owned-uni-coupon-buy',
    get: () => ({ fetch: async () => new Response(`uni_coupon_buy_${++number}`) }) } });
  const events: KvEvent[] = [], original = s.env.CONFIG_KV;
  Object.assign(s.env, { CONFIG_KV: { ...original,
    put: async (key: string, value: string, options?: KVNamespacePutOptions) => {
      events.push({ operation: 'put', key, ttl: options?.expirationTtl }); await original.put(key, value, options);
    },
    delete: async (key: string) => { events.push({ operation: 'delete', key }); await original.delete(key); },
  } });
  const calls: H['calls'] = [];
  const request: S['request'] = (path, body, bearer, method) => { calls.push({ path, body, bearer }); return s.request(path, body, bearer, method); };
  return { s, events, calls, request };
}

/** Every public relation and nontransactional sequence, not merely the coupon
 * tables. Confirmation's existing TTL KV records are audited separately. */
async function snapshot(s: S) {
  const relations = await s.f.exec("SELECT relname AS name,relkind AS kind FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','S') ORDER BY relname");
  expect(relations.filter(row => row.kind === 'r')).toHaveLength(283);
  const result: Record<string, unknown> = {};
  for (const row of relations) {
    const name = String(row.name); expect(name).toMatch(/^[a-z][a-z0-9_]*$/u);
    result[name] = await s.f.exec(row.kind === 'S' ? `SELECT last_value,is_called FROM public."${name}"`
      : `SELECT to_jsonb(t) AS row FROM public."${name}" t ORDER BY to_jsonb(t)::text`);
  }
  expect(relations.some(row => row.kind === 'S')).toBe(true);
  return result;
}
async function readOnly<T>(h: H, work: () => Promise<T>, expectedPuts = 0) {
  const before = await snapshot(h.s), start = h.events.length, value = await work();
  expect(await snapshot(h.s)).toEqual(before);
  const events = h.events.slice(start);
  expect(events).toHaveLength(expectedPuts);
  expect(events.every(event => event.operation === 'put' && event.ttl === 1800)).toBe(true);
  return value;
}
async function ok(h: H, path: string, body?: unknown, bearer?: string | null) {
  const r = await h.request(path, body, bearer); expect(r.status, `${path}: ${r.msg}`).toBe(200); return r.data;
}
async function grant(h: H, id = issueId) {
  const data = await ok(h, '/api/coupon/receive', { id });
  expect(data.couponUserId).toBeGreaterThan(0); return Number(data.couponUserId);
}
async function add(h: H) {
  const data = await ok(h, '/api/cart/add', { productId: 70, unique: 'qared001', cartNum: 2, type: 0, new: 1 });
  expect(data.id).toBe(data.cartId); expect(data.id).toBeGreaterThan(2);
  const [row] = await h.s.f.db.select().from(storeCart).where(eq(storeCart.id, data.id));
  expect(row).toMatchObject({ uid: 11, productId: 70, productAttrUnique: 'qared001', cartNum: 2, type: 0, isNew: 1, isPay: 0 });
  return Number(data.id);
}
const options = (cartId: number, couponId: number) => ({ cartIds: [cartId], type: 0, addressId: 11, shippingType: 1, storeId: 0, couponId, useIntegral: true });
async function quote(h: H, cartId: number, ownedId: number) {
  const body = options(cartId, ownedId), start = h.events.length;
  const q = await readOnly(h, () => ok(h, '/api/order/confirm', body), 2);
  expect(h.events.slice(start).map(event => event.key)).toEqual([
    `order:confirm:11:${q.orderKey}`, `order:quote:v1:11:0:${q.orderKey}:${q.quoteToken}`,
  ]);
  expect(q.priceGroup).toMatchObject({ sumPrice: '20.00', totalPrice: '20.00', couponPrice: '5.00',
    deduction_price: '1.00', usedIntegral: 100, total_postage: '6.00', pay_postage: '6.00', storePostageDiscount: '0.00', pay_price: '20.00' });
  const computedStart = h.events.length;
  const computed = await readOnly(h, () => ok(h, '/api/order/computed/' + q.orderKey, body), 1);
  expect(computed).toMatchObject({ orderKey: q.orderKey, couponPrice: '5.00', deduction_price: '1.00', usedIntegral: 100, pay_price: '20.00' });
  expect(h.events[computedStart].key).toBe(`order:quote:v1:11:0:${q.orderKey}:${computed.quoteToken}`);
  expect(computed.quoteToken).not.toBe(q.quoteToken);
  return { ...body, quoteToken: computed.quoteToken, key: q.orderKey };
}
async function createCancelOnce(h: H, cartId: number, ownedId: number) {
  const selection = await quote(h, cartId, ownedId), { key, ...payload } = selection;
  expect(payload).not.toHaveProperty('payType');
  const foreign = await h.s.token(22);
  await readOnly(h, async () => {
    expect((await h.request('/api/order/create/' + key, payload, foreign)).status).not.toBe(200);
    expect((await h.request('/api/order/computed/' + key, payload, foreign)).status).not.toBe(200);
  });
  const made = await ok(h, '/api/order/create/' + key, payload);
  expect(made.key).toBe(key);
  const [order] = await h.s.f.db.select().from(storeOrder).where(eq(storeOrder.orderId, made.orderId));
  expect(order).toMatchObject({ uid: 11, paid: 0, status: 0, type: 0, couponId: ownedId, payPrice: '20.00', useIntegral: '100.00' });
  expect(Number(order.payPrice)).toBeGreaterThan(0);
  expect(await h.s.f.db.select().from(storeOrder)).toHaveLength(1);
  const lines = await h.s.f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id));
  expect(lines).toHaveLength(1); expect(lines[0]).toMatchObject({ uid: 11, cartId: String(cartId), productId: 70, cartNum: 2 });
  const resources = async () => ({
    product: (await h.s.f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0],
    sku: (await h.s.f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)))[0],
    cart: (await h.s.f.db.select().from(storeCart).where(eq(storeCart.id, cartId)))[0],
    coupon: (await h.s.f.db.select().from(storeCouponUser).where(eq(storeCouponUser.id, ownedId)))[0],
    buyer: (await h.s.f.db.select().from(user).where(eq(user.uid, 11)))[0],
  });
  const reserved = await resources();
  expect(reserved.product.stock).toBe(6); expect(reserved.sku.stock).toBe(6); expect(reserved.cart.isPay).toBe(1);
  expect(reserved.coupon).toMatchObject({ uid: 11, status: 3, useTime: null }); expect(reserved.buyer.integral).toBe(0);
  const bills = () => h.s.f.db.select().from(userBill).where(and(eq(userBill.uid, 11), eq(userBill.linkId, String(order.id)), eq(userBill.category, 'integral'))).orderBy(userBill.id);
  expect(await bills()).toMatchObject([{ pm: 0, type: 'deduction', eventKey: 'order_integral_deduction', number: '100.00' }]);
  await readOnly(h, async () => { expect(await ok(h, '/api/order/create/' + key, payload)).toEqual(made); });
  expect(await h.s.f.db.select().from(storeOrder)).toHaveLength(1); expect(await bills()).toHaveLength(1);
  await readOnly(h, async () => { expect((await h.request('/api/order/cancel', { id: order.orderId }, foreign)).status).not.toBe(200); });
  const issueBefore = await h.s.f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, issueId));
  await ok(h, '/api/order/cancel', { id: order.orderId });
  const restored = await resources();
  expect(restored.product.stock).toBe(8); expect(restored.sku.stock).toBe(8); expect(restored.cart.isPay).toBe(0);
  expect(restored.coupon).toMatchObject({ uid: 11, status: 0, useTime: null }); expect(restored.buyer.integral).toBe(100);
  expect(await bills()).toMatchObject([
    { pm: 0, type: 'deduction', eventKey: 'order_integral_deduction', number: '100.00' },
    { pm: 1, type: 'order_cancel', eventKey: 'order_cancel_integral_back', number: '100.00' },
  ]);
  expect(await h.s.f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, issueId))).toEqual(issueBefore);
  expect((await h.s.f.db.select().from(storeOrder).where(eq(storeOrder.id, order.id)))[0]).toMatchObject({ paid: 0, status: -2, isDel: 1 });
  await readOnly(h, async () => { expect((await h.request('/api/order/cancel', { id: order.orderId })).status).not.toBe(200); });
  expect(await bills()).toHaveLength(2);
  expect(h.calls.filter(call => call.path === '/api/cart/add')).toHaveLength(1);
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Uni coupon immediate-buy actual JWT, commissioned restricted PG16 and complete SQL evidence', () => {
  it('signs only authorized response pictures across actual carts, confirmation and owned order reads without persisting capabilities', async () => withBuyerInvoices(async s => {
    const h = await setup(s), r2 = buyerReviewR2(), assetId = 991301, foreignAssetId = 991302;
    const canonical = '/api/assets/' + assetId, name = 'attachments/supplier/7/uni_coupon_buy_native.png';
    r2.objects.set(name, { bytes: buyerReviewPng.slice(), contentType: 'image/png' });
    r2.objects.set('attachments/supplier/8/foreign.png', { bytes: buyerReviewPng.slice(), contentType: 'image/png' });
    Object.assign(s.env, { ASSETS_BUCKET: r2.bucket });
    await s.f.db.insert(systemAttachment).values([
      { attId: assetId, type: 4, relationId: 7, moduleType: 1, fileType: 1, imageType: 8,
        name, attDir: canonical, sattDir: canonical, attType: 'image/png', attSize: String(buyerReviewPng.length) },
      { attId: foreignAssetId, type: 4, relationId: 8, moduleType: 1, fileType: 1, imageType: 8,
        name: 'attachments/supplier/8/foreign.png', attDir: '/api/assets/' + foreignAssetId,
        sattDir: '/api/assets/' + foreignAssetId, attType: 'image/png', attSize: String(buyerReviewPng.length) },
    ]);
    await s.f.db.update(storeProduct).set({ image: canonical }).where(eq(storeProduct.id, 70));
    await s.f.db.update(storeProductAttrValue).set({ image: canonical }).where(eq(storeProductAttrValue.id, 1));
    const cartId = await add(h), ownedId = await grant(h);
    await ok(h, '/api/cart/add', { productId: 70, unique: 'qared001', cartNum: 1, type: 0, new: 0 });
    const signed = (value: unknown) => {
      expect(typeof value).toBe('string');
      const url = new URL(String(value), 'http://127.0.0.1');
      expect(url.pathname).toBe(canonical);
      expect([...url.searchParams.keys()].sort()).toEqual(['expires', 'signature']);
      expect(url.searchParams.get('expires')).toMatch(/^[1-9]\d*$/u);
      expect(url.searchParams.get('signature')).toMatch(/^[A-Za-z0-9_-]+$/u);
      return url;
    };
    const image200 = async (value: unknown) => {
      const url = signed(value), response = await s.fetch(new Request(url));
      expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('image/png');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(buyerReviewPng);
    };
    await readOnly(h, async () => {
      // The real pricing source stays canonical. A bare private reference is
      // correctly rejected before R2, exactly the failed Browser boundary.
      const raw = await new StoreCartService(s.appContainer, s.env).list(11, { mode: 'buy', ids: [cartId] }) as any[];
      expect(raw[0].productInfo.image).toBe(canonical);
      expect((await s.fetch(new Request('http://127.0.0.1' + canonical))).status).toBe(404);
      expect(r2.reads).toEqual([]);
      for (const path of ['/api/cart/list', '/api/cart/list?scope=cart', `/api/cart/list?scope=buy&ids=${cartId}`]) {
        const rows = await ok(h, path), item = rows.find((row: any) => row.productId === 70);
        expect(item).toBeTruthy(); await image200(item.productInfo.image);
        const before = r2.reads.length, invalid = signed(item.productInfo.image);
        invalid.searchParams.set('signature', 'invalid');
        expect((await s.fetch(new Request(invalid))).status).toBe(404);
        const expired = signed(item.productInfo.image), expiredAt = Math.floor(Date.now() / 1000) - 60;
        expired.searchParams.set('expires', String(expiredAt));
        // This separate URL has a valid MAC for its actual expired timestamp;
        // the malformed-signature rejection above cannot satisfy this check.
        expect(typeof s.env.APP_KEY).toBe('string');
        const expiredSignature = createHmac('sha256', s.env.APP_KEY!)
          .update(`GET\n${canonical}\n${expiredAt}`).digest('base64url');
        expired.searchParams.set('signature', expiredSignature);
        expect((await s.fetch(new Request(expired))).status).toBe(404);
        expect(r2.reads).toHaveLength(before);
      }
      const legacy = await ok(h, '/api/v2/cart_list'), row = legacy.find((item: any) => item.product_id === 70);
      expect(row).toBeTruthy(); await image200(row.productInfo.image); await image200(row.productInfo.attrInfo.image);
      expect((await h.request(`/api/cart/list?scope=buy&ids=${cartId}`, undefined, await s.token(22))).status).not.toBe(200);
    });
    for (const image of ['/api/assets/' + foreignAssetId, '/api/assets/991399', 'javascript:alert(1)']) {
      await s.f.db.update(storeProduct).set({ image }).where(eq(storeProduct.id, 70));
      await readOnly(h, async () => {
        const rows = await ok(h, `/api/cart/list?scope=buy&ids=${cartId}`);
        expect(rows[0].productInfo.image).toBe('');
      });
    }
    await s.f.db.update(storeProduct).set({ image: canonical, type: 99 }).where(eq(storeProduct.id, 70));
    await readOnly(h, async () => {
      const rows = await ok(h, `/api/cart/list?scope=buy&ids=${cartId}`);
      expect(rows[0].productInfo.image).toBe('');
    });
    await s.f.db.update(storeProduct).set({ type: 2 }).where(eq(storeProduct.id, 70));
    const body = options(cartId, ownedId);
    const q = await readOnly(h, async () => {
      const value = await ok(h, '/api/order/confirm', body);
      await image200(value.cartInfo[0].productInfo.image); await image200(value.cartInfo[0].productInfo.attrInfo.image);
      return value;
    }, 2);
    const computed = await readOnly(h, async () => {
      const value = await ok(h, '/api/order/computed/' + q.orderKey, body);
      await image200(value.cartInfo[0].productInfo.image); await image200(value.cartInfo[0].productInfo.attrInfo.image);
      return value;
    }, 1);
    for (const event of h.events) {
      const value = await s.env.CONFIG_KV.get(event.key);
      expect(value).not.toContain(canonical + '?'); expect(value).not.toContain('expires=');
    }
    const made = await ok(h, '/api/order/create/' + q.orderKey, { ...body, quoteToken: computed.quoteToken });
    const [order] = await s.f.db.select().from(storeOrder).where(eq(storeOrder.orderId, made.orderId));
    const [line] = await s.f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id));
    // Persisted product media ownership is supplier2/7. Activity type0 is not
    // an attachment owner, and no returned signature becomes durable JSON.
    expect(line).toMatchObject({ type: 2, relationId: 7 });
    expect(JSON.parse(line.cartInfo!).product.image).toBe(canonical);
    expect(line.cartInfo).not.toContain('expires='); expect(line.cartInfo).not.toContain('signature=');
    await readOnly(h, async () => {
      const detail = await ok(h, '/api/order/detail/' + made.orderId);
      await image200(detail.cartInfo[0].cartInfo.product.image);
      const orders = await ok(h, '/api/order/list');
      await image200(orders.find((row: any) => row.orderId === made.orderId).cartInfo[0].cartInfo.product.image);
      expect((await h.request('/api/order/detail/' + made.orderId, undefined, await s.token(22))).status).not.toBe(200);
      // Legacy JSON cannot supply its own media owner. Missing persisted owner
      // fields fail closed for every recognized image slot, without mutation.
      const legacy = { ...line, cartInfo: { product: { image: canonical }, sku: { image: canonical },
        productInfo: { type: 1, relation_id: 0, image: canonical, attrInfo: { image: canonical } } } };
      const [valid] = await projectOrderPictures(s.appContainer.db, s.env.APP_KEY, [legacy]);
      await image200(valid.cartInfo.product.image); await image200(valid.cartInfo.sku.image);
      await image200(valid.cartInfo.productInfo.image); await image200(valid.cartInfo.productInfo.attrInfo.image);
      for (const malformed of [{ ...legacy, type: undefined as unknown as number },
        { ...legacy, relationId: undefined as unknown as number }]) {
        const [hidden] = await projectOrderPictures(s.appContainer.db, s.env.APP_KEY, [malformed]);
        expect(hidden.cartInfo.product.image).toBe(''); expect(hidden.cartInfo.sku.image).toBe('');
        expect(hidden.cartInfo.productInfo.image).toBe(''); expect(hidden.cartInfo.productInfo.attrInfo.image).toBe('');
      }
      expect(legacy.cartInfo.product.image).toBe(canonical); expect(legacy.cartInfo.sku.image).toBe(canonical);
      expect(legacy.cartInfo.productInfo.image).toBe(canonical); expect(legacy.cartInfo.productInfo.attrInfo.image).toBe(canonical);
      const [foreign] = await projectOrderPictures(s.appContainer.db, s.env.APP_KEY, [{ ...line,
        cartInfo: { productInfo: { type: 2, relation_id: 8, image: '/api/assets/' + foreignAssetId } } }]);
      expect(foreign.cartInfo.productInfo.image).toBe('');
    });
    await s.f.db.update(storeOrderCartInfo).set({ type: 99 }).where(eq(storeOrderCartInfo.id, line.id));
    await readOnly(h, async () => {
      expect((await ok(h, '/api/order/detail/' + made.orderId)).cartInfo[0].cartInfo.product.image).toBe('');
    });
    await s.f.db.update(storeOrderCartInfo).set({ type: line.type }).where(eq(storeOrderCartInfo.id, line.id));
    await s.f.db.update(systemAttachment).set({ moduleType: 2 }).where(eq(systemAttachment.attId, assetId));
    await readOnly(h, async () => {
      expect((await ok(h, '/api/order/detail/' + made.orderId)).cartInfo[0].cartInfo.product.image).toBe('');
      expect((await ok(h, '/api/cart/list?scope=cart'))[0].productInfo.image).toBe('');
    });
    await s.f.db.update(systemAttachment).set({ moduleType: 1 }).where(eq(systemAttachment.attId, assetId));
    expect((await s.f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0].image).toBe(canonical);
    expect((await s.f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)))[0].image).toBe(canonical);
    expect((await s.f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, line.id)))[0].cartInfo).toBe(line.cartInfo);
    expect(r2.reads.length).toBeGreaterThan(0); expect(new Set(r2.reads)).toEqual(new Set([name]));
    expect(r2.writes).toEqual([]); expect(r2.deletes).toEqual([]);
    await ok(h, '/api/order/cancel', { id: made.orderId });
  }), 120000);

  it('adds exactly one new1 cart, grants through the sole endpoint, resolves its actual cid, quotes coupon plus points and cancels once', async () => withBuyerInvoices(async s => {
    const h = await setup(s);
    await s.f.db.update(storeCouponIssue).set({ receiveLimit: 1 }).where(eq(storeCouponIssue.id, issueId));
    await readOnly(h, async () => {
      expect((await ok(h, directory)).items.find((row: { id: number }) => row.id === issueId)).toMatchObject({ receivedCount: 0, claimable: true });
      expect(await ok(h, receipt())).toMatchObject({ uid: 11, productId: 70, couponId: issueId, receivedCount: 0, latestCouponUserId: null });
      expect((await h.request(receipt(), undefined, null)).status).not.toBe(200);
      expect((await h.request('/api/coupon/receive', { id: issueId }, null)).status).not.toBe(200);
    });
    const cartId = await add(h), ownedId = await grant(h);
    expect((await s.f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, issueId)))[0].remainCount).toBe(4);
    expect(await s.f.db.select().from(storeCouponIssueUser).where(eq(storeCouponIssueUser.issueCouponId, issueId))).toHaveLength(1);
    await readOnly(h, async () => {
      expect(await ok(h, receipt())).toMatchObject({ uid: 11, receivedCount: 1, latestCouponUserId: ownedId });
      expect(await ok(h, receipt(), undefined, await s.token(22))).toMatchObject({ uid: 22, receivedCount: 0, latestCouponUserId: null });
      const response = await h.request(picker(cartId)); expect(response.status, response.msg).toBe(200);
      expect(normalizeOrderCouponPage(response.data, response.headers.get('x-coupon-next-cursor')).list).toMatchObject([{ id: ownedId, issueId }]);
      expect((await h.request(picker(cartId), undefined, await s.token(22))).status).not.toBe(200);
      expect((await h.request(picker(cartId).replace('new=1', 'new=0'))).status).not.toBe(200);
      expect((await h.request('/api/coupon/receive', { id: issueId })).status).not.toBe(200);
    });
    await createCancelOnce(h, cartId, ownedId);
    expect(h.calls.filter(call => call.path === '/api/coupon/receive' && call.bearer !== null)).toHaveLength(2); // one successful grant, one limit rejection
    expect(await s.f.db.select().from(storeCouponUser).where(eq(storeCouponUser.issueCouponId, issueId))).toHaveLength(1);
  }), 120000);

  it('uses an older eligible owned copy when the receipt maximum is spent, without another grant, and resolves a null hint only from the actual picker', async () => withBuyerInvoices(async s => {
    const h = await setup(s), older = await grant(h), latest = await grant(h);
    expect(latest).toBeGreaterThan(older);
    // Declared historical use specimen. Both owned rows were issued by the
    // actual sole endpoint; this fixture change does not fabricate a grant.
    await s.f.db.update(storeCouponUser).set({ status: 1, useTime: new Date() }).where(eq(storeCouponUser.id, latest));
    const grantsBefore = h.calls.filter(call => call.path === '/api/coupon/receive').length;
    const cartId = await add(h);
    await readOnly(h, async () => {
      expect((await ok(h, directory)).items.find((row: { id: number }) => row.id === issueId)).toMatchObject({ receivedCount: 2, claimable: false });
      expect(await ok(h, receipt())).toMatchObject({ receivedCount: 2, latestCouponUserId: latest });
      const raw = await ok(h, `/api/cart/list?scope=buy&ids=${cartId}`), rows = validateCheckoutItems(raw, [cartId], 1);
      const r = await h.request(picker(cartId)); expect(r.status, r.msg).toBe(200);
      const page = normalizeOrderCouponPage(r.data, r.headers.get('x-coupon-next-cursor'));
      expect(page.list).toMatchObject([{ id: older, issueId }]); expect(page.list.some(row => row.id === latest)).toBe(false);
      const attempt = '1763170000000:1:0123456789abcdef', saved = new Map<string, string>();
      const intent: ProductCouponBuyIntent = { version: 1, uid: 11, attempt, productId: 70, unique: 'qared001', quantity: 2, issueId,
        title: '本机完整领券购买', phase: 'ready', cartId, ownedId: null, claimAttempt: null, evidence: 'directory', decision: 'apply' };
      saved.set(productCouponBuyKey(11), JSON.stringify(intent));
      const journal = new ProductCouponBuyJournal({ get: key => saved.get(key), set: (key, value) => { saved.set(key, value); }, remove: key => { saved.delete(key); } });
      const selection = parseProductCouponBuySelection({ mode: 'buy', cartId: String(cartId), couponBuy: attempt })!;
      const preselection = new ProductCouponBuyPreselection(selection, journal, { uid: 11, version: 1 }), scope = orderCouponScope(rows, 1, 0);
      preselection.bind(scope, { uid: 11, version: 1 }, rows);
      expect(preselection.accept({ ...page, fingerprint: scope.fingerprint, loading: false, error: '' }, { uid: 11, version: 1 }).couponId).toBe(older);
      expect(journal.read(11)?.ownedId).toBe(older);
    });
    await createCancelOnce(h, cartId, older);
    expect(h.calls.filter(call => call.path === '/api/coupon/receive')).toHaveLength(grantsBefore);
    expect((await s.f.db.select().from(storeCouponUser).where(eq(storeCouponUser.id, latest)))[0].status).toBe(1);
    expect(await s.f.db.select().from(storeCouponIssueUser).where(eq(storeCouponIssueUser.issueCouponId, issueId))).toHaveLength(2);
  }), 120000);

  it('excludes foreign, expired and inapplicable owned coupons and rechecks revocation at authoritative create without retaining resources', async () => withBuyerInvoices(async s => {
    const h = await setup(s), valid = await grant(h), wrongProduct = await grant(h, otherIssueId), expired = await grant(h, expiredIssueId);
    const foreign = await s.token(22), foreignOwned = await ok(h, '/api/coupon/receive', { id: issueId }, foreign);
    await s.f.db.update(storeCouponUser).set({ endTime: new Date(Date.now() - 60000) }).where(eq(storeCouponUser.id, expired));
    const cartId = await add(h);
    await readOnly(h, async () => {
      const list = await ok(h, picker(cartId)); expect(list.map((row: { id: number }) => row.id)).toEqual([valid]);
      for (const id of [wrongProduct, expired, foreignOwned.couponUserId]) {
        expect((await h.request('/api/order/confirm', options(cartId, id))).status).not.toBe(200);
      }
      expect((await h.request('/api/order/confirm', options(cartId, valid), foreign)).status).not.toBe(200);
    });
    const { key, ...payload } = await quote(h, cartId, valid);
    await s.f.db.update(storeCouponUser).set({ isFail: 1 }).where(eq(storeCouponUser.id, valid));
    await readOnly(h, async () => {
      expect((await h.request('/api/order/create/' + key, payload)).status).not.toBe(200);
      expect((await ok(h, picker(cartId))).some((row: { id: number }) => row.id === valid)).toBe(false);
    });
    expect(await s.f.db.select().from(storeOrder)).toEqual([]);
    expect((await s.f.db.select().from(storeCart).where(eq(storeCart.id, cartId)))[0].isPay).toBe(0);
    expect((await s.f.db.select().from(user).where(eq(user.uid, 11)))[0].integral).toBe(100);
    expect(await s.f.db.select().from(userBill).where(eq(userBill.uid, 11))).toEqual([]);
    const stale = await s.token();
    await s.f.db.update(user).set({ pwd: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }).where(eq(user.uid, 11));
    await readOnly(h, async () => {
      expect((await h.request(receipt(), undefined, stale)).status).not.toBe(200);
      expect((await h.request(picker(cartId), undefined, stale)).status).not.toBe(200);
      expect((await h.request('/api/order/create/' + key, payload, stale)).status).not.toBe(200);
    });
  }), 120000);
});
