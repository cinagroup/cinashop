import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { storeCombination, storeOrder, storeOrderCartInfo, storePink, storeProduct } from '../src/models/schema';
import { combinationGroupsQuery, combinationMembersQuery, combinationOrdersQuery, combinationStatisticsAvatar,
  combinationStatisticsId } from '../src/services/admin/AdminCombinationStatisticsInput';
import { combinationStatisticsOrderStatus } from '../src/services/admin/AdminCombinationStatisticsService';
import { combinationStatisticsFixture } from './helpers/combinationStatisticsFixture';

const query = (value = '') => new URLSearchParams(value);
describe('combination statistics strict query and safe avatar contracts', () => {
  it.each(['0', '-1', '01', '1.0', '1e2', ' 1', '2147483648', '', undefined])('rejects invalid ID %s', value => {
    expect(() => combinationStatisticsId(value)).toThrow('无效');
  });
  it.each(['page=0', 'page=', 'limit=0', 'limit=101', 'page=102&limit=100', 'page=1&page=2',
    'status=4', 'status=1&status=2', 'arbitrary=x', 'start_day=2026-02-30', 'start_day=2026-09-27&end_day=2026-09-26',
    'end_day=2026/09/26', 'combination_id=0', 'keyword=%00'])('refuses invalid leader query %s', value => {
    expect(() => combinationGroupsQuery(query(value))).toThrow();
  });
  it('parses Shanghai days as a half-open interval and enforces fixed scopes and all independent pagination paths', () => {
    expect(combinationGroupsQuery(query('start_day=2026-09-26&end_day=2026-09-26'))).toMatchObject({
      page: 1, limit: 15, offset: 0, start: Date.parse('2026-09-25T16:00:00Z') / 1000, stop: Date.parse('2026-09-26T16:00:00Z') / 1000,
    });
    expect(combinationMembersQuery(query('page=10001&limit=1'))).toEqual({ page: 10001, limit: 1, offset: 10000 });
    expect(() => combinationGroupsQuery(query('combination_id=501'), 501)).toThrow('不支持');
    expect(() => combinationMembersQuery(query('keyword=x'))).toThrow('不支持');
    expect(() => combinationMembersQuery(query('page=1&page=1'))).toThrow('重复');
    expect(() => combinationOrdersQuery(query('status=6'))).toThrow('无效');
    expect(() => combinationOrdersQuery(query('keyword=x&keyword=x'))).toThrow('重复');
    expect(combinationOrdersQuery(query('status=all'))).toMatchObject({ status: undefined });
  });
  it.each(['/api/assets/1?signature=untrusted', 'https://site.example/api/assets/12?signature=x', '/r2/secret.png',
    '/images/../api/assets/123?signature=untrusted', '/images/%2e%2e/api/assets/123', '/images/../r2/secret.png',
    '/images/%252e%252e/%2561pi/assets/123', 'https://public.example/images/%2e%2e/api/assets/123',
    'attachments/admin/1/a.png', 'https://account.r2.cloudflarestorage.com/private/a.png', 'javascript:alert(1)',
    '//evil.example/a.png', 'https://a:b@example.com/a.png', '/images/a\\b.png', 'data:image/png;base64,aaaa'])('does not preview private or unsafe avatar %s', value => {
    expect(combinationStatisticsAvatar(value)).toBe('');
  });
  it('allows safe static and public HTTPS avatar snapshots without signing or fetch', () => {
    expect(combinationStatisticsAvatar('/images/avatar.png')).toBe('/images/avatar.png');
    expect(combinationStatisticsAvatar('https://public.example/avatar.png')).toBe('https://public.example/avatar.png');
  });
  it.each([
    [{ is_del: 1 }, '已删除'], [{ is_system_del: 1 }, '已删除'], [{ paid: 0 }, '待付款'],
    [{ status: 4, shipping_type: 3 }, '部分发货'], [{ refund_status: 2 }, '已退款'],
    [{ status: 5, shipping_type: 2 }, '部分核销'], [{ status: 5, shipping_type: 1 }, '部分收货'],
    [{ refund_status: 1 }, '申请退款'], [{ refund_status: 4 }, '退款中'], [{ status: 0 }, '未发货'],
    [{ status: 1, shipping_type: 2 }, '未核销'], [{ status: 1 }, '待收货'], [{ status: 2 }, '待评价'],
    [{ status: 3 }, '已完成'], [{ refund_status: 3 }, '部分退款'], [{ status: 9 }, '未知'],
  ] as const)('preserves ordered legacy status projection %j => %s', (extra, expected) => {
    expect(combinationStatisticsOrderStatus({ is_del: 0, is_system_del: 0, paid: 1, status: 0, shipping_type: 1, refund_status: 0, ...extra })).toBe(expected);
  });
});

describe('real SQL historical combination statistics', () => {
  let f: Awaited<ReturnType<typeof combinationStatisticsFixture>>;
  beforeEach(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No external I/O')); f = await combinationStatisticsFixture(); }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  it('keeps exact six-card uid0/refund distinctions and gross paid roots without any fanout or write', async () => {
    const before = await f.snapshot();
    expect(await f.service.head(501)).toEqual({ id: 501, store_name: '活动%_甲', activity_deleted: false,
      people_count: 5, spread_count: 5, start_count: 4, success_count: 2, pay_price: '110.09', pay_count: 4 });
    expect(await f.service.globalHead()).toEqual({ participant_record_count: 12, success_count: 3 });
    expect(await f.service.head(503)).toMatchObject({ activity_deleted: true, people_count: 0, pay_price: '0.00', pay_count: 0 });
    await expect(f.service.head(504)).rejects.toMatchObject({ code: 404 });
    expect(await f.snapshot()).toEqual(before);
  });
  it('pages leaders with Shanghai boundaries, stored status and stable same-second sorting, without settlement', async () => {
    const before = await f.snapshot();
    const leaders = await f.service.groups(query('start_day=2026-09-26&end_day=2026-09-26&limit=2'), 501);
    expect(leaders).toMatchObject({ count: 3, page: 1, limit: 2 }); expect(leaders.list.map(row => row.id)).toEqual([9008, 9007]);
    expect((await f.service.groups(query('start_day=2026-09-26&end_day=2026-09-26&page=2&limit=2'), 501)).list.map(row => row.id)).toEqual([9001]);
    const pending = await f.service.groups(query('status=1'), 501);
    expect(pending).toMatchObject({ count: 1 });
    expect(pending.list[0]).toMatchObject({ id: 9001, status: 1, status_raw: 1, expired_pending: true,
      member_count_raw: 99, participant_record_count: 5, active_real_count: 3, virtual_count: 1 });
    expect(await f.snapshot()).toEqual(before);
    expect(await f.service.globalHead()).toEqual({ participant_record_count: 12, success_count: 3 });
  });
  it('uses literal keyword nickname/title/phone/UID search and keeps orphan, deleted and virtual history', async () => {
    expect((await f.service.groups(query('keyword=团长%25_'))).list.map(row => row.id)).toEqual([9001]);
    expect((await f.service.groups(query('keyword=活动%25_'))).count).toBe(4);
    expect((await f.service.groups(query('keyword=13800000102'))).list[0]).toMatchObject({ id: 9005, deleted_user: true, missing_user: false, is_refund: 9005 });
    const orphan = (await f.service.groups(query('keyword=孤儿活动'))).list[0];
    expect(orphan).toMatchObject({ id: 9011, activity_missing: true, missing_user: true, deleted_user: false, avatar_preview: '' });
    expect(orphan.issues.join(' ')).toContain('活动缺失');
    const virtual = (await f.service.groups(query('keyword=历史虚拟团长'))).list[0];
    expect(virtual).toMatchObject({ id: 9007, deleted_user: false, missing_user: false }); expect(virtual.issues.join(' ')).toContain('虚拟');
    await f.db.update(storeCombination).set({ isDel: 1 }).where(eq(storeCombination.id, 501));
    expect((await f.service.groups(query(), 501)).list.every(row => row.activity_deleted)).toBe(true);
  });
  it('keeps malformed time/status and zero relation IDs visible with issues rather than aborting a history page', async () => {
    await f.exec("UPDATE public.store_pink SET stop_time='infinity',status=7,combination_id=0,product_id=0 WHERE id=9011");
    const row = (await f.service.groups(query('keyword=孤儿活动'))).list[0];
    expect(row).toMatchObject({ status: 7, status_raw: 7, combination_id: 0, product_id: 0, stop_time: null, expired_pending: false });
    expect(row.issues.join(' ')).toContain('结束时间无效'); expect(row.issues.join(' ')).toContain('状态无效');
  });
  it('retains missing/deleted activity member history but never links an order through zero activity/product identities', async () => {
    await f.db.update(storePink).set({ combinationId: 0, productId: 0, orderId: 'ORPHAN-ZERO', orderIdKey: 'zero-key' }).where(eq(storePink.id, 9011));
    await f.db.insert(storeOrder).values({ id: 9998, type: 3, activityId: 0, uid: 103, pinkId: 9011, orderId: 'ORPHAN-ZERO', unique: 'zero-key' });
    const missing = await f.service.members(9011, query());
    expect(missing).toMatchObject({ group_id: 9011, combination_id: 0, count: 1 });
    expect(missing.list[0]).toMatchObject({ order_id: '', order_db_id: null, detail_available: false });
    expect(missing.list[0].issues.join(' ')).toContain('活动缺失');
    expect(missing.list[0].issues.join(' ')).toContain('身份无效');
    await f.db.update(storeCombination).set({ isDel: 1 }).where(eq(storeCombination.id, 501));
    expect((await f.service.members(9001, query())).list[0].issues.join(' ')).toContain('活动已删除');
  });
  it('returns only selected leader plus same-activity non-refunded children with safe exact order identities', async () => {
    const before = await f.snapshot(), result = await f.service.members(9001, query());
    expect(result).toMatchObject({ group_id: 9001, combination_id: 501, count: 4, page: 1, limit: 15, replacement_leader_id: null });
    expect(result.list.map(row => row.pink_id)).toEqual([9012, 9002, 9003, 9001]);
    expect(result.list.find(row => row.pink_id === 9001)).toMatchObject({ order_id: 'BUSINESS-9101', order_db_id: 9101, detail_available: true, order_deleted: false });
    expect(result.list.find(row => row.pink_id === 9002)).toMatchObject({ order_id: 'BUSINESS-9102', order_db_id: 9102, detail_available: false, order_deleted: true });
    expect(result.list.find(row => row.pink_id === 9003)).toMatchObject({ is_virtual: 1, deleted_user: false, missing_user: false, order_id: '', order_db_id: null, detail_available: false });
    expect(result.list.find(row => row.pink_id === 9012)).toMatchObject({ order_id: 'BUSINESS-9109', order_db_id: 9109, detail_available: true });
    await expect(f.service.members(9001, query(), 502)).rejects.toMatchObject({ code: 404 });
    await expect(f.service.members(9002, query())).rejects.toMatchObject({ code: 404 });
    expect(await f.snapshot()).toEqual(before);
  });
  it('does not resolve conflicting order number/key or wrong type/activity/uid/pink through an OR expansion', async () => {
    for (const changes of [{ orderIdKey: 'key-one' }, { orderId: 'BUSINESS-9101' }, { productId: 701 }, { people: 2 }]) {
      await f.db.update(storePink).set(changes).where(eq(storePink.id, 9002));
      const before = await f.snapshot(), row = (await f.service.members(9001, query())).list.find(value => value.pink_id === 9002)!;
      expect(row).toMatchObject({ order_id: '', order_db_id: null, detail_available: false }); expect(await f.snapshot()).toEqual(before);
      await f.db.update(storePink).set({ orderId: 'BUSINESS-9102', orderIdKey: 'key-two', productId: 700, people: 3 }).where(eq(storePink.id, 9002));
    }
    for (const changes of [{ type: 1 }, { activityId: 502 }, { uid: 104 }, { pinkId: 9005 }]) {
      await f.db.update(storeOrder).set(changes).where(eq(storeOrder.id, 9101));
      expect((await f.service.members(9001, query())).list.find(row => row.pink_id === 9001)).toMatchObject({ order_id: '', detail_available: false });
      await f.db.update(storeOrder).set({ type: 3, activityId: 501, uid: 101, pinkId: 9001 }).where(eq(storeOrder.id, 9101));
    }
  });
  it('refuses an ambiguous key matching an order ID and another order unique without expanding member/count', async () => {
    await f.db.update(storePink).set({ orderId: '', orderIdKey: '9990' }).where(eq(storePink.id, 9001));
    await f.db.insert(storeOrder).values([{ id: 9990, type: 3, activityId: 501, uid: 101, pinkId: 9001, orderId: 'AMBIGUOUS-1', unique: 'ambiguous-one' },
      { id: 9991, type: 3, activityId: 501, uid: 101, pinkId: 9001, orderId: 'AMBIGUOUS-2', unique: '9990' }]);
    const result = await f.service.members(9001, query()), row = result.list.find(value => value.pink_id === 9001)!;
    expect(result.count).toBe(4); expect(row).toMatchObject({ order_id: '', order_db_id: null, detail_available: false });
    expect(row.issues.join(' ')).toContain('匹配不唯一');
  });
  it('keeps a refunded promoted old leader explicit and never follows or merges the replacement group', async () => {
    await f.db.update(storePink).set({ kId: 9008, isRefund: 9008, status: 3 }).where(eq(storePink.id, 9005));
    await f.db.update(storeOrder).set({ pinkId: 9008 }).where(eq(storeOrder.id, 9103));
    const old = await f.service.members(9005, query(), 501);
    expect(old).toMatchObject({ group_id: 9005, combination_id: 501, replacement_leader_id: 9008, count: 2 });
    expect(old.list.map(row => row.pink_id)).toEqual([9005, 9006]);
    expect(old.list[0]).toMatchObject({ is_refund: 9008, order_id: 'BUSINESS-9103', deleted_user: true, detail_available: true });
    expect(old.list[1]).toMatchObject({ missing_user: true, detail_available: false });
  });
  it('preserves the actual Worker refund promotion state: old leader keeps own refund ID and order while current children move', async () => {
    await f.db.update(storePink).set({ isRefund: 9001, status: 3 }).where(eq(storePink.id, 9001));
    await f.db.update(storePink).set({ kId: 0 }).where(eq(storePink.id, 9002));
    for (const id of [9003, 9012]) await f.db.update(storePink).set({ kId: 9002 }).where(eq(storePink.id, id));
    for (const id of [9102, 9109]) await f.db.update(storeOrder).set({ pinkId: 9002 }).where(eq(storeOrder.id, id));
    const before = await f.snapshot(), old = await f.service.members(9001, query(), 501), current = await f.service.members(9002, query(), 501);
    expect(old).toMatchObject({ group_id: 9001, replacement_leader_id: null, count: 1 });
    expect(old.list[0]).toMatchObject({ pink_id: 9001, is_refund: 9001, order_id: 'BUSINESS-9101', detail_available: true });
    expect(current.count).toBe(3); expect(current.list.map(row => row.pink_id).sort()).toEqual([9002, 9003, 9012]);
    expect(current.list.find(row => row.pink_id === 9012)).toMatchObject({ order_id: 'BUSINESS-9109', detail_available: true });
    expect(await f.snapshot()).toEqual(before);
  });
  it('uses actual paid root predicates for both order list and count, preserving gross refund/deletion history', async () => {
    const before = await f.snapshot(), result = await f.service.orders(501, query());
    expect(result).toMatchObject({ count: 5, page: 1, limit: 15 }); expect(result.list.map(row => row.id)).toEqual([9109, 9104, 9103, 9102, 9101]);
    expect(result.list.find(row => row.id === 9102)).toMatchObject({ deleted: true, detail_available: false, status: '已删除', order_id: 'BUSINESS-9102' });
    expect(result.list.find(row => row.id === 9103)).toMatchObject({ status: '已退款', pay_price: '30.30' });
    expect(await f.service.orders(501, query('status=0'))).toMatchObject({ count: 0, list: [] });
    expect((await f.service.orders(501, query('status=1'))).count).toBe(4);
    expect(await f.service.orders(501, query('page=2&limit=3'))).toMatchObject({ count: 5, page: 2, limit: 3 });
    expect(await f.snapshot()).toEqual(before);
  });
  it('supports all legacy broad keyword sources with EXISTS and literal matching, without cart/address fanout', async () => {
    await f.db.insert(storeProduct).values({ id: 702, storeName: '商品标题AB', stock: 10 });
    await f.db.insert(storeOrderCartInfo).values({ id: 9303, oid: 9103, uid: 102, productId: 702, unique: 'stat-cart-3' });
    for (const [keyword, expected] of [['用户甲', 2], ['地址联系人', 2], ['13711112222', 2], ['搜索商品', 1],
      ['商品标题%_', 1], ['组合活动简介', 5], ['活动%_', 5], ['BUSINESS-9101', 1]] as const) {
      const result = await f.service.orders(501, query(`keyword=${encodeURIComponent(keyword)}`));
      expect(result.count, keyword).toBe(expected); expect(result.list.length, keyword).toBe(expected);
    }
    expect((await f.service.head(501)).pay_price).toBe('110.09');
  });
  it('uses the exact status/shipping/refund predicates and keeps empty bounded pages honest', async () => {
    for (const [status, shippingType, refundStatus, selected] of [[0, 1, 0, 1], [4, 3, 3, 1], [1, 1, 0, 2], [5, 1, 3, 2],
      [0, 2, 0, 2], [2, 1, 0, 3], [3, 1, 3, 4], [1, 2, 0, 5]] as const) {
      await f.db.update(storeOrder).set({ status, shippingType, refundStatus }).where(eq(storeOrder.id, 9101));
      const result = await f.service.orders(501, query(`keyword=BUSINESS-9101&status=${selected}`));
      expect(result).toMatchObject({ count: 1 }); expect(result.list[0].id).toBe(9101);
    }
    expect(await f.service.groups(query('page=10001&limit=1'))).toMatchObject({ count: 6, list: [], page: 10001, limit: 1 });
    expect(await f.service.members(9001, query('page=10001&limit=1'))).toMatchObject({ count: 4, list: [], page: 10001, limit: 1 });
  });
});
