import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeService, storeProduct, storeProductLog, user, systemConfig } from '../src/models/schema';
import { readCustomerWorkScope } from '../src/services/customer-work/CustomerWorkScope';
import { CustomerWorkReadService, CUSTOMER_WORK_METRIC_SCOPES } from '../src/services/customer-work/CustomerWorkReadService';
import { storeOrderRefundSplit } from '../src/models/schema/order_refund_split';
import { refundOrderSplitFingerprint } from '../src/services/order/RefundOrderSplitIdentity';
import { ExpressService } from '../src/services/order/ExpressService';
import { businessMidnight } from '../src/services/admin/AdminStatisticService';
import { createToken, md5 } from '../src/utils/jwt';
import { customerWorkReadFixture, customerReadNow, observeCustomerReadDb } from './helpers/customerWorkReadFixture';
import * as FrontendContract from '../../view/uniapp-ts/src/utils/customerWork';

describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('customer mobile work read contract under actual SELECT-only native PG16 LOGIN', () => {
  let f: Awaited<ReturnType<typeof customerWorkReadFixture>>;
  beforeAll(async () => { f = await customerWorkReadFixture(); }, 60000);
  afterAll(async () => { vi.unstubAllGlobals(); await f?.close(); }, 60000);
  beforeEach(async () => { vi.unstubAllGlobals(); await f.reset(); });
  it('authorizes the unique customer grant independently from chat status, mer scope and every other staff role', async () => {
    await f.app(async db => {
      expect(await readCustomerWorkScope(db, 101)).toMatchObject({ actor_uid: 101, service_id: 1 });
      expect((await f.reader(db).context(f.actor())).principal).toEqual({ kind: 'customer-order-manager', service_id: 1, scope: 'global' });
      for (const uid of [0, 102, 103, 104, 105, 106, 107, 108, 109]) { expect(await readCustomerWorkScope(db, uid, false)).toBe(null); await expect(f.reader(db).context(f.actor(uid))).rejects.toThrow(); }
      await f.db.update(storeService).set({ merId: 12345 }).where(eq(storeService.id, 1));
      expect((await f.reader(db).orders(f.actor())).data.list.map(row => row.id)).toEqual([1]);
    });
  });
  it('rejects disabled deleted revoked duplicate and expired identities with actual current user and service SQL', async () => {
    await f.app(async db => {
      for (const values of [{ status: 0 }, { isDel: 1 }, { deleteTime: new Date() }]) { await f.db.update(user).set({ status: 1, isDel: 0, deleteTime: null, ...values }).where(eq(user.uid, 101)); await expect(f.reader(db).overview(f.actor())).rejects.toThrow(); }
      await f.db.update(user).set({ status: 1, isDel: 0, deleteTime: null }).where(eq(user.uid, 101));
      await expect(f.reader(db).context({ ...f.actor(), expires_at: Math.floor(Date.now() / 1000) - 1 })).rejects.toThrow();
      for (const values of [{ accountStatus: 0 }, { customer: 0 }, { isDel: 1 }]) { await f.db.update(storeService).set({ accountStatus: 1, customer: 1, isDel: 0, ...values }).where(eq(storeService.id, 1)); await expect(f.reader(db).context(f.actor())).rejects.toThrow(); }
      await f.db.update(storeService).set({ accountStatus: 1, customer: 1, isDel: 0 }).where(eq(storeService.id, 1));
      await f.db.insert(storeService).values({ id: 9, uid: 101, account: 'duplicate-customer', customer: 1, accountStatus: 1, status: 0 });
      await expect(f.reader(db).context(f.actor())).rejects.toThrow('重复');
    });
  });
  it('retains all platform store supplier and split fulfillments but excludes negative payment headers from global totals', async () => {
    await f.db.insert(storeOrder).values([f.order(2, { storeId: 77 }), f.order(3, { supplierId: 88 }), f.order(4, { pid: 99 }), f.order(5, { pid: -1, payPrice: '999.00' }), f.order(6, { isSystemDel: 1, payPrice: '999.00' })]);
    await f.app(async db => { const r = f.reader(db), s = await r.statistics(f.actor(), { type: '1' }, customerReadNow), overview = await r.overview(f.actor(), {}, customerReadNow); expect(s.data.counters).toMatchObject({ order_count: 4, sum_price: '49.36', unshipped_count: 2 }); expect(s.data.summary).toMatchObject({ after_price: '49.36', after_number: 4, after_pay_number: 1 }); expect(overview.data.badges.unshipped_count).toBe(2); expect(s.data.metric_scopes).toEqual(CUSTOMER_WORK_METRIC_SCOPES); expect((await r.orders(f.actor())).data.list.map(row => row.id)).toEqual([4, 3, 2, 1]); });
  });
  it('uses the legacy platform selectors for all six state cards and keeps refunds and inventory global', async () => {
    await f.db.delete(storeOrder);
    const cases = [{ paid: 0, status: 0 }, { paid: 1, status: 4 }, { paid: 1, status: 1 }, { paid: 1, status: 2 }, { paid: 1, status: 0, shippingType: 2 }, { paid: 1, status: 3 }];
    await f.db.insert(storeOrder).values(cases.flatMap((values, i) => [f.order(10 + i, values), f.order(30 + i, { ...values, storeId: 77 }), f.order(50 + i, { ...values, supplierId: 88 })]));
    await f.db.insert(storeOrderRefund).values([f.refund(1, { storeOrderId: 10 }), f.refund(2, { storeOrderId: 30, storeId: 77, refundType: 6 }), f.refund(3, { storeOrderId: 50, supplierId: 88, refundType: 3 })]);
    await f.db.insert(storeProduct).values([{ id: 2, type: 1, relationId: 77, storeName: '门店预警', pid: 0, stock: 999, isPolices: 1, isShow: 1, isVerify: 1 }, { id: 3, type: 2, relationId: 88, storeName: '供应商售罄', stock: 0, isVerify: 1 }, { id: 4, storeName: '零库存警告不计', stock: 0, isPolices: 1, isShow: 1, isVerify: 1 }, { id: 5, storeName: '未审核不计', stock: 5, isPolices: 1, isShow: 1, isVerify: 0 }, { id: 6, storeName: '下架不预警', stock: 5, isPolices: 1, isShow: 0, isVerify: 1 }, { id: 7, storeName: '非预警不计', stock: 5, isPolices: 0, isShow: 1, isVerify: 1 }]);
    await f.app(async db => { const s = await f.reader(db).statistics(f.actor(), {}, customerReadNow); expect(s.data.counters).toMatchObject({ order_count: 18, unpaid_count: 1, unshipped_count: 1, received_count: 2, evaluated_count: 1, unwritoff_count: 1, complete_count: 1, refunding_count: 1, refunded_count: 2, refund_count: 3 }); expect((await f.reader(db).overview(f.actor(), {}, customerReadNow)).data.badges).toMatchObject({ outofstock: 2, policeforce: 1, refund_count: 3 }); });
  });
  it('matches old business order selectors including partial shipment and negative refunds instead of raw status', async () => {
    await f.db.delete(storeOrder); await f.db.delete(storeOrderCartInfo);
    const inputs = [f.order(1, { paid: 0 }), f.order(2), f.order(3, { status: 4 }), f.order(4, { status: 1 }), f.order(5, { status: 5, shippingType: 2 }), f.order(6, { status: 2 }), f.order(7, { status: 3 }), f.order(8, { refundStatus: 1, pid: -1 }), f.order(9, { refundStatus: 2 }), f.order(10, { refundStatus: 4, pid: 99 }), f.order(11, { isDel: 1 })];
    await f.db.insert(storeOrder).values(inputs);
    await f.app(async db => { const r = f.reader(db); const expected: Record<string, number[]> = { '0': [1], '1': [3, 2], '2': [5, 4], '3': [6], '4': [7], '5': [5], '6': [], '7': [3], '8': [5], '9': [7, 6], '-1': [10, 8], '-2': [9], '-3': [10, 9, 8] }; for (const [status, ids] of Object.entries(expected)) expect((await r.orders(f.actor(), { status })).data.list.map(row => row.id)).toEqual(ids); expect((await r.orders(f.actor(), { status: '-4', is_del: '1' })).data.list.map(row => row.id)).toEqual([11]); await expect(r.orders(f.actor(), { status: '-4' })).rejects.toThrow(); });
  });
  it('preserves refundTypes selectors actual original order identity and business refund-number detail', async () => {
    await f.db.insert(storeOrderRefund).values(Array.from({ length: 7 }, (_, refundType) => f.refund(refundType + 1, { refundType, applyType: refundType % 4 + 1 })));
    await f.app(async db => { const r = f.reader(db), expected: Record<string, number[]> = { '0': [0], '1': [1, 2], '2': [4, 5], '3': [5], '4': [6], '5': [0, 1, 2, 4, 5], '6': [3, 6] }; for (const [refundTypes, types] of Object.entries(expected)) expect((await r.refunds(f.actor(), { refundTypes })).data.list.map(row => row.refund_type).sort()).toEqual(types); const detail = await r.refundDetail(f.actor(), 'customer-refund-3'); expect(detail.data).toMatchObject({ id: 3, order_id: 'customer-refund-3', store_order_sn: 'customer-order-1', store_order_id: 1, add_time: customerReadNow }); expect((await r.refundDetail(f.actor(), '3')).data.id).toBe(3); expect((await r.refunds(f.actor(), { apply_type: '2' })).data.list.map(row => row.apply_type)).toEqual([2, 2]); const before = await f.db.select().from(storeOrderRefund); await f.db.insert(storeOrderRefund).values(f.refund(99, { orderId: '3' })); await expect(r.refundDetail(f.actor(), '3')).rejects.toThrow('歧义'); expect((await f.db.select().from(storeOrderRefund)).slice(0, before.length)).toEqual(before); });
  });
  it('uses Shanghai midnight current-second inclusion equal-duration previous periods and continuous 1 7 30 day trends', async () => {
    await f.db.delete(storeOrder); await f.db.delete(storeOrderCartInfo); const midnight = businessMidnight(2026, 9, 4), now = midnight + 43200;
    await f.db.insert(storeOrder).values([f.order(1, { payPrice: '0.10', addTime: midnight }), f.order(2, { payPrice: '0.20', uid: 202, addTime: now }), f.order(3, { payPrice: '999.00', addTime: now + 1 }), f.order(4, { payPrice: '0.11', addTime: midnight - 1 }), f.order(5, { payPrice: '999.00', addTime: midnight - 43202 })]);
    await f.db.insert(storeProductLog).values([{ productId: 1, type: 'visit', addTime: midnight }, { productId: 1, type: 'visit', addTime: now }, { productId: 1, type: 'visit', addTime: now + 1 }, { productId: 1, type: 'cart', addTime: now }, { productId: 1, type: 'visit', addTime: now, deleteTime: new Date() }]);
    await f.app(async db => { const r = f.reader(db), s = await r.statistics(f.actor(), { type: '1' }, now); expect(s.data.summary).toMatchObject({ after_price: '0.30', increase_time: '0.19', growth_rate: 172, after_number: 2, after_pay_number: 2, today_visits: 2 }); const trend = (await r.trend(f.actor(), { type: '1' }, now)).data.list; expect(trend).toEqual([{ date: '2026-10-03', time: '10-03', num: 2, price: '999.11' }, { date: '2026-10-04', time: '10-04', num: 2, price: '0.30' }]); for (const type of ['7', '30']) { const list = (await r.trend(f.actor(), { type }, now)).data.list; expect(list).toHaveLength(Number(type)); expect(list[0].price).toBe('0.00'); expect(list.at(-1)?.date).toBe('2026-10-04'); } });
  });
  it('returns real daily sums visits and descending pages with date bounds and total count', async () => {
    await f.db.insert(storeOrder).values([f.order(2, { addTime: customerReadNow - 86400, payPrice: '6.17' }), f.order(3, { addTime: customerReadNow - 2 * 86400, payPrice: '0.10' })]);
    await f.db.insert(storeProductLog).values({ productId: 1, type: 'visit', addTime: customerReadNow });
    await f.app(async db => { const r = f.reader(db), query = { start: String(customerReadNow - 3 * 86400), stop: String(customerReadNow), page: '1', limit: '1' }, a = (await r.daily(f.actor(), query, customerReadNow)).data, b = (await r.daily(f.actor(), { ...query, page: '2' }, customerReadNow)).data; expect(a).toMatchObject({ count: 3, has_more: true, list: [{ date: '2026-10-04', price: '12.34', count: 1, visit: 1 }] }); expect(b.list[0]).toMatchObject({ date: '2026-10-03', price: '6.17' }); await expect(r.daily(f.actor(), { start: '10', stop: '1' })).rejects.toThrow(); });
  });
  it('paginates and searches actual customer order and product fields without widening percent literals', async () => {
    await f.db.insert(storeOrder).values([f.order(2), f.order(3, { realName: '含%名字' })]); await f.db.insert(storeOrderCartInfo).values(f.cart(2));
    await f.app(async db => { const r = f.reader(db), a = await r.orders(f.actor(), { limit: '1' }), b = await r.orders(f.actor(), { limit: '1', page: '2' }); expect(a.data).toMatchObject({ count: 3, has_more: true }); expect(a.data.list[0].id).toBe(3); expect(b.data.list[0].id).toBe(2); expect((await r.orders(f.actor(), { field_key: 'title', keyword: '搜索商品' })).data.list.map(row => row.id)).toEqual([2, 1]); expect((await r.orders(f.actor(), { keyword: '%' })).data.list.map(row => row.id)).toEqual([3]); expect((await r.orders(f.actor(), { keyword: '实际客户' })).data.count).toBe(3); await expect(r.orders(f.actor(), { uid: '101' })).rejects.toThrow('不支持'); await expect(r.orders(f.actor(), { field_key: 'uid', keyword: '2147483648' })).rejects.toThrow(); });
  });
  it('projects signed owned images exact normalized money and allowed PII without wallets passwords or foreign media', async () => {
    const cart = JSON.parse(f.cart(1).cartInfo!); cart.productInfo.price = '12'; cart.productInfo.attrInfo.price = '12'; cart.truePrice = '12'; cart.vip_truePrice = '0.34';
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(cart) }).where(eq(storeOrderCartInfo.id, 1));
    await f.db.update(storeOrder).set({ refundReasonWapImg: '["/api/assets/51","/api/assets/52"]', customForm: '{"收件要求":"轻放"}' }).where(eq(storeOrder.id, 1));
    await f.app(async db => { const result = (await f.reader(db).orderDetail(f.actor(), 'customer-order-1')).data; expect(result).toMatchObject({ total_price: '12.00', vip_true_price: '0.34', pay_price: '12.34', real_name: '实际收件人', custom_form: { 收件要求: '轻放' } }); expect(result.cartInfo[0].truePrice).toBe('12.00'); expect(result.cartInfo[0].productInfo.image).toMatch(/^\/api\/assets\/41\?/); expect(result.customer.avatar).toMatch(/^\/api\/assets\/51\?/); expect(result.refund_img[0]).toMatch(/^\/api\/assets\/51\?/); expect(result.refund_img[1]).toBe(''); expect(JSON.stringify(result)).not.toMatch(/PRIVATE|pwd|now_money|202\.00/); });
  });
  it('keeps real split parents and exact child identity without moving original refund ownership', async () => {
    await f.db.update(storeOrder).set({ pid: -1, deliveryType: 'split' }).where(eq(storeOrder.id, 1)); await f.db.insert(storeOrder).values([f.order(2, { pid: 1 }), f.order(3, { pid: 1 })]);
    await f.app(async db => { const result = (await f.reader(db).orderDetail(f.actor(), 'customer-order-1')).data; expect(result.split.map(child => child.order_id)).toEqual(['customer-order-2', 'customer-order-3']); await f.db.update(storeOrder).set({ uid: 202 }).where(eq(storeOrder.id, 3)); await expect(f.reader(db).orderDetail(f.actor(), 'customer-order-1')).rejects.toThrow('父子'); });
  });
  it('rejects foreign cart owner impossible money oversized JSON and generation markers without durable evidence', async () => {
    await f.app(async db => { const r = f.reader(db); await f.db.update(storeOrderCartInfo).set({ uid: 202 }).where(eq(storeOrderCartInfo.id, 1)); await expect(r.orderDetail(f.actor(), 'customer-order-1')).rejects.toThrow('归属'); const badMoney = JSON.parse(f.cart(1).cartInfo!); badMoney.truePrice = '-1.00'; await f.db.update(storeOrderCartInfo).set({ uid: 201, cartInfo: JSON.stringify(badMoney) }).where(eq(storeOrderCartInfo.id, 1)); await expect(r.orderDetail(f.actor(), 'customer-order-1')).rejects.toThrow('金额'); await f.db.update(storeOrderCartInfo).set({ cartInfo: f.cart(1).cartInfo }).where(eq(storeOrderCartInfo.id, 1)); await f.db.insert(storeOrderCartInfo).values(f.cart(2, { oid: 1, cartId: 'cart-1' })); await expect(r.orderDetail(f.actor(), 'customer-order-1')).rejects.toThrow('关联'); await f.db.delete(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, 2)); await f.db.update(storeOrderCartInfo).set({ cartInfo: 'x'.repeat(65537) }).where(eq(storeOrderCartInfo.id, 1)); await expect(r.orderDetail(f.actor(), 'customer-order-1')).rejects.toThrow('容量'); const cart = JSON.parse(f.cart(1).cartInfo!); cart.financial_version = 'refund-order-line-finance-v1'; cart.refund_order_generation = { refundId: 501, role: 'selected' }; await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(cart) }).where(eq(storeOrderCartInfo.id, 1)); await expect(r.orderDetail(f.actor(), 'customer-order-1')).rejects.toThrow(); expect(await f.db.select().from(storeOrderRefund)).toEqual([]); });
  });
  it('uses one actual repeatable-read read-only snapshot and leaves every business table unchanged', async () => {
    await f.db.insert(storeOrderRefund).values(f.refund(1));
    const business = async () => (await f.db.execute<{ data: string }>(sql`SELECT md5(jsonb_build_array((SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM store_order o),(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM store_order_refund r),(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM store_order_cart_info c))::text) AS data`))[0].data;
    await f.app(async db => { const before = await business(), commands: string[] = [], observed = observeCustomerReadDb(db, async (tx, command) => { commands.push(command); if (command.includes('SET TRANSACTION')) expect((await tx.execute<{ ro: string; iso: string }>(sql`SELECT current_setting('transaction_read_only') AS ro,current_setting('transaction_isolation') AS iso`))[0]).toEqual({ ro: 'on', iso: 'repeatable read' }); }), r = new CustomerWorkReadService(createContainerFromDb(observed), f.env); await r.context(f.actor()); await r.overview(f.actor(), {}, customerReadNow); await r.statistics(f.actor(), {}, customerReadNow); await r.trend(f.actor(), {}, customerReadNow); await r.daily(f.actor(), {}, customerReadNow); await r.orders(f.actor()); await r.orderDetail(f.actor(), 'customer-order-1'); await r.refunds(f.actor()); await r.refundDetail(f.actor(), 'customer-refund-1'); expect(commands.filter(command => command.includes('SET TRANSACTION'))).toHaveLength(9); expect(commands.filter(command => /FOR\s+(SHARE|UPDATE)|^(INSERT|UPDATE|DELETE|MERGE)/i.test(command.trim()))).toEqual([]); expect(await business()).toBe(before); });
  });
  it('rejects midway role or account revocation and password changes instead of releasing an old readonly snapshot', async () => {
    for (const mutation of [async () => f.db.update(storeService).set({ customer: 0 }).where(eq(storeService.id, 1)), async () => f.db.update(storeService).set({ accountStatus: 0 }).where(eq(storeService.id, 1)), async () => f.db.update(user).set({ deleteTime: new Date() }).where(eq(user.uid, 101)), async () => f.db.update(user).set({ pwd: 'changed-password' }).where(eq(user.uid, 101))]) {
      await f.reset(); await f.app(async db => { let changed = false; const observed = observeCustomerReadDb(db, async (_tx, command) => { if (!changed && command.includes('from "store_service"')) { changed = true; await mutation(); } }), reader = new CustomerWorkReadService(createContainerFromDb(observed), f.env); await expect(reader.statistics(f.actor(), {}, customerReadNow)).rejects.toThrow(); expect(changed).toBe(true); });
    }
  });
  it('uses old order values in one snapshot while a writer commits new money and fences later readers with changed consistency', async () => {
    await f.app(async db => { const initial = await f.reader(db).orders(f.actor()); let changed = false; const observed = observeCustomerReadDb(db, async (_tx, command) => { if (!changed && command.includes('from "store_service"')) { changed = true; await f.db.update(storeOrder).set({ payPrice: '99.00' }).where(eq(storeOrder.id, 1)); } }), r = new CustomerWorkReadService(createContainerFromDb(observed), f.env), old = await r.statistics(f.actor(), {}, customerReadNow), current = await f.reader(db).statistics(f.actor(), {}, customerReadNow); expect(old.data.summary.after_price).toBe('12.34'); expect(old.consistency_key).toBe(initial.consistency_key); expect(current.data.summary.after_price).toBe('99.00'); expect(current.consistency_key).not.toBe(initial.consistency_key); });
  });
  it('executes signed UserJWT HTTP controllers with private envelopes and rejects Admin Kefu guests duplicate query and forged scope', async () => {
    await f.app(async db => { const h = f.http(db), api = (await createToken(101, 'api', md5('owned-customer-password'), f.env.APP_KEY)).token, admin = (await createToken(101, 'admin', md5('owned-customer-password'), f.env.APP_KEY)).token, kefu = (await createToken(101, 'kefu', md5('owned-customer-password'), f.env.APP_KEY)).token, keys = []; for (const path of ['/context', '/overview', '/statistics', '/trend', '/statistics/orders', '/orders', '/orders/customer-order-1', '/refunds']) { const response = await h.request(path, { headers: { Authorization: `Bearer ${api}` } }, f.env), body = await response.json() as { status: number; data: { actor_uid: number; consistency_key: string; principal: { kind: string } } }; expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('private, no-store'); expect(body).toMatchObject({ status: 200, data: { actor_uid: 101, principal: { kind: 'customer-order-manager' } } }); keys.push(body.data.consistency_key); } expect(new Set(keys).size).toBe(1); for (const token of ['', admin, kefu]) expect((await h.request('/context', { headers: token ? { Authorization: `Bearer ${token}` } : {} }, f.env)).status).toBe(400); for (const path of ['/orders?status=1&status=2', '/orders?uid=101', '/orders?store_id=77', '/orders?scope_key=' + '0'.repeat(64)]) expect((await h.request(path, { headers: { Authorization: `Bearer ${api}` } }, f.env)).status).toBe(400); });
  });
  it('returns true merchant tracking degradation and refund return logistics from real business numbers without invented events', async () => {
    await f.db.update(storeOrder).set({ status: 1, deliveryType: 'express', deliveryCode: 'actual', deliveryName: '实际快递', deliveryId: 'TRACK-A' }).where(eq(storeOrder.id, 1));
    await f.db.insert(storeOrderRefund).values(f.refund(1, { refundType: 5, refundExpress: 'RETURN-A', refundExpressName: '实际退货快递' }));
    await f.app(async db => { const r = f.reader(db), result = await r.logistics(f.actor(), 'customer-order-1'); expect(result.data).toMatchObject({ trackingState: 'not_configured', trackingSource: 'merchant', express: [], order: { order_id: 'customer-order-1', delivery_id: 'TRACK-A' } }); const refund = await r.logistics(f.actor(), 'customer-refund-1', { type: 'refund' }); expect(refund.data).toMatchObject({ trackingState: 'not_configured', express: [], order: { delivery_id: 'RETURN-A' } }); });
  });
  it('rechecks current customer scope after real carrier transport and rejects revoked result without another request', async () => {
    await f.db.update(storeOrder).set({ status: 1, deliveryType: 'express', deliveryCode: 'actual', deliveryName: '实际快递', deliveryId: 'TRACK-A' }).where(eq(storeOrder.id, 1)); await f.db.insert(systemConfig).values([{ menuName: 'logistics_type', value: '2' }, { menuName: 'system_express_app_code', value: 'owned-provider-fixture-key' }]); let calls = 0;
    vi.stubGlobal('fetch', async () => { calls++; await f.db.update(storeService).set({ customer: 0 }).where(eq(storeService.id, 1)); return new Response(JSON.stringify({ status: '0', result: { status: '0', list: [{ time: '2026-10-04 10:00:00', status: '实际承运商夹具轨迹' }] } }), { status: 200 }); });
    await f.app(async db => { await expect(f.reader(db).logistics(f.actor(), 'customer-order-1')).rejects.toThrow(); expect(calls).toBe(1); await expect(f.reader(db).logistics(f.actor(), 'customer-order-1')).rejects.toThrow(); expect(calls).toBe(1); });
  });
  it('publishes all ten actual SELECT-only reader DTOs through the real frontend envelope and data guards', async () => {
    await f.db.update(storeOrder).set({ status: 1, deliveryType: 'express', deliveryCode: 'actual', deliveryName: '实际快递', deliveryId: 'TRACK-A' }).where(eq(storeOrder.id, 1));
    await f.db.insert(storeOrderRefund).values(f.refund(1));
    await f.app(async db => {
      const r = f.reader(db), actor = f.actor(), context = await r.context(actor);
      const authority = FrontendContract.parseCustomerWorkEnvelope(context, actor.uid, FrontendContract.isCustomerWorkContext);
      const accepted = <T>(value: unknown, guard: (data: unknown) => data is T) => FrontendContract.parseCustomerWorkEnvelope(value, actor.uid, guard, authority);
      accepted(await r.overview(actor, {}, customerReadNow), FrontendContract.isCustomerWorkOverview);
      accepted(await r.statistics(actor, {}, customerReadNow), FrontendContract.isCustomerWorkStatistics);
      accepted(await r.trend(actor, {}, customerReadNow), FrontendContract.isCustomerWorkTrend);
      accepted(await r.daily(actor, {}, customerReadNow), FrontendContract.isCustomerWorkPaged(FrontendContract.isCustomerWorkDaily));
      accepted(await r.orders(actor), FrontendContract.isCustomerWorkPaged(FrontendContract.isCustomerWorkOrder));
      accepted(await r.orderDetail(actor, 'customer-order-1'), FrontendContract.isCustomerWorkOrderDetail);
      accepted(await r.refunds(actor), FrontendContract.isCustomerWorkPaged(FrontendContract.isCustomerWorkRefund));
      accepted(await r.refundDetail(actor, 'customer-refund-1'), FrontendContract.isCustomerWorkRefundDetail);
      accepted(await r.logistics(actor, 'customer-order-1', { type: '' }), FrontendContract.isCustomerWorkLogistics);
    });
  });
  it('resolves real refund generation partitions without repointing the original refund and fingerprints its proof', async () => {
    await f.db.update(storeOrder).set({ pid: -1 }).where(eq(storeOrder.id, 1));
    await f.db.insert(storeOrder).values([f.order(2, { pid: 1, refundStatus: 2, refundType: 6 }), f.order(3, { pid: 1 })]);
    const cart = (id: number, role: 'selected' | 'remaining') => { const original = f.cart(id, { cartId: String(id), refundNum: role === 'selected' ? 1 : 0 }); return { ...original, cartInfo: JSON.stringify({ ...JSON.parse(original.cartInfo!), financial_version: 'refund-order-line-finance-v1', refund_order_generation: { refundId: 1, role } }) }; };
    await f.db.insert(storeOrderCartInfo).values([cart(2, 'selected'), cart(3, 'remaining')]);
    await f.db.insert(storeOrderRefund).values(f.refund(1, { refundType: 6, refundedPrice: '1.00', cartInfo: JSON.stringify({ cartIds: [{ cartId: 1, cartNum: 1 }], quantityReservation: { version: 'refund-quantity-materialization-v2', orderId: 1, uid: 201, items: [{ rowId: 1, cartId: 1, cartNum: 1, beforeRefundNum: 0, totalNum: 2 }] } }) }));
    const [refund] = await f.db.select().from(storeOrderRefund);
    const partitions = [{ sourceCartId: '1', selectedRowId: 2, selectedNum: 1, remainingRowId: 3, remainingNum: 1 }];
    await f.db.insert(storeOrderRefundSplit).values({ refundId: 1, fingerprint: await refundOrderSplitFingerprint(refund), uid: 201, storeId: 0, supplierId: 0, sourceOrderId: 1, paymentOrderId: 1, selectedOrderId: 2, remainingOrderId: 3, disposition: 'split', previousRefundId: 0, returnedPointBillIds: '[]', earnedIncomeScope: 'null', sourceSnapshot: '{}', partitions: JSON.stringify(partitions), addTime: customerReadNow });
    await f.app(async db => { const r = f.reader(db), selected = await r.orderDetail(f.actor(), 'customer-order-2'), remaining = await r.orderDetail(f.actor(), 'customer-order-3'); expect(selected.data.refund).toMatchObject([{ id: 1, order_id: 'customer-refund-1' }]); expect(remaining.data.refund).toEqual([]); expect((await f.db.select().from(storeOrderRefund))[0]).toEqual(refund); await f.db.update(storeOrderRefundSplit).set({ partitions: JSON.stringify([{ ...partitions[0], remainingNum: 2 }]) }).where(eq(storeOrderRefundSplit.refundId, 1)); expect((await r.context(f.actor())).consistency_key).not.toBe(remaining.consistency_key); await expect(r.orderDetail(f.actor(), 'customer-order-3')).rejects.toThrow('证据'); });
  });
  it('copies the actor before context SQL so caller mutation cannot replace the authorized profile', async () => {
    await f.app(async db => { const actor = f.actor(), observed = observeCustomerReadDb(db, async (_tx, command) => { if (command.includes('from "store_service"')) actor.uid = 202; }), r = new CustomerWorkReadService(createContainerFromDb(observed), f.env), result = await r.context(actor); expect(actor.uid).toBe(202); expect(result.actor_uid).toBe(101); expect(result.data.profile.uid).toBe(101); const authority = FrontendContract.parseCustomerWorkEnvelope(result, 101, FrontendContract.isCustomerWorkContext); await f.db.update(user).set({ nickname: '变更后的经营员' }).where(eq(user.uid, 101)); const current = await f.reader(db).overview(f.actor(), {}, customerReadNow); expect(current.consistency_key).not.toBe(result.consistency_key); expect(() => FrontendContract.parseCustomerWorkEnvelope(current, 101, FrontendContract.isCustomerWorkOverview, authority)).toThrow('数据依据'); });
  });
  it('opens an actual user-deleted list item and its express tracking while rejecting system-deleted identity', async () => {
    await f.db.update(storeOrder).set({ isDel: 1, status: 1, deliveryType: 'express', deliveryCode: 'actual', deliveryName: '实际快递', deliveryId: 'DELETED-TRACK' }).where(eq(storeOrder.id, 1));
    await f.app(async db => { const r = f.reader(db), list = await r.orders(f.actor(), { status: '-4', is_del: '1' }); expect(list.data.list.map(row => row.order_id)).toEqual(['customer-order-1']); const detail = await r.orderDetail(f.actor(), list.data.list[0].order_id); expect(detail.data.order_id).toBe(list.data.list[0].order_id); const rows = await f.db.select().from(storeOrder), ordinary = new ExpressService(createContainerFromDb(db), f.env); await expect(ordinary.queryScopedOrders(rows, async () => {})).rejects.toThrow('范围'); await expect(ordinary.query(201, detail.data.order_id)).rejects.toThrow(); expect((await r.logistics(f.actor(), detail.data.order_id)).data.order.delivery_id).toBe('DELETED-TRACK'); await f.db.update(storeOrder).set({ isSystemDel: 1 }).where(eq(storeOrder.id, 1)); await expect(r.orderDetail(f.actor(), detail.data.order_id)).rejects.toThrow('不存在'); await expect(r.logistics(f.actor(), detail.data.order_id)).rejects.toThrow('不存在'); const systemDeleted = await f.db.select().from(storeOrder); await expect(ordinary.queryScopedOrders(systemDeleted, async () => {}, { allowUserDeleted: true })).rejects.toThrow('范围'); expect((await r.orders(f.actor(), { status: '-4', is_del: '1' })).data.list).toEqual([]); });
  });
});
