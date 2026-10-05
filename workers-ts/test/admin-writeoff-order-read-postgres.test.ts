import { afterEach, beforeEach, expect, it } from 'vitest';
import { financePostgres } from './helpers/financePostgres';
import { createContainerFromDb } from '../src/lib/di';
import { storeBargain, storeCombination, storeOrder, storeOrderCartInfo,
  storeProduct, storeSeckill, systemStore, systemStoreStaff, user, userAddress } from '../src/models/schema';
import { AdminWriteoffOrderReadService } from '../src/services/admin/AdminWriteoffOrderReadService';
import { requiredAdminPermission } from '../src/services/admin/AdminPermissionService';

let f: Awaited<ReturnType<typeof financePostgres>>;
const service = () => new AdminWriteoffOrderReadService(createContainerFromDb(f.db));
const sec = (date: string) => Math.floor(Date.parse(date) / 1000);
const good = (id: number) => JSON.stringify({ truePrice: '12.50',
  productInfo: { id, store_name: '购买时商品', image: '/img/item.png',
    attrInfo: { suk: '红色' } } });

beforeEach(async () => {
  f = await financePostgres([user, userAddress, storeOrder, storeOrderCartInfo,
    storeProduct, storeSeckill, storeBargain, storeCombination, systemStore, systemStoreStaff]);
  await f.db.insert(user).values([
    { uid: 11, nickname: '买家甲', phone: '13800000011', spreadUid: 20 },
    { uid: 12, nickname: '买家乙', spreadUid: 0 },
    { uid: 20, nickname: '推荐人', realName: '私密实名', cardId: 'CARD-DO-NOT-RETURN',
      nowMoney: '5.25', brokeragePrice: '3.00', phone: '13800000020',
      mark: '推荐人备注', integral: 7, birthday: sec('1990-01-01T00:00:00Z'),
      lastTime: sec('2026-09-28T02:00:00Z'), avatar: '/avatar.png' },
  ]);
  await f.db.insert(systemStore).values([
    { id: 31, name: '开放门店', isDel: 0, isShow: 1, addTime: 300 },
    { id: 32, name: '隐藏门店', isDel: 0, isShow: 0, addTime: 400 },
    { id: 33, name: '删除门店', isDel: 1, isShow: 1, addTime: 500 },
  ]);
  await f.db.insert(systemStoreStaff).values({ id: 41, uid: 200, storeId: 31,
    staffName: '核销员甲', pwd: 'SHOULD-NOT-RETURN' });
  await f.db.insert(storeOrder).values([
    { id: 101, orderId: 'VERIFY-101', uid: 11, spreadUid: 20,
      storeId: 31, clerkId: 200, paid: 1, status: 2, shippingType: 2,
      refundStatus: 0, isDel: 0, payPrice: '25.00', payType: 'weixin',
      addTime: sec('2026-09-28T01:01:00Z'), payTime: sec('2026-09-28T01:02:00Z') },
    { id: 102, orderId: 'VERIFY-102', uid: 12, pid: -1, paid: 1,
      status: 2, shippingType: 2, refundStatus: 3, isDel: 0, isSystemDel: 1,
      payPrice: '9.00', addTime: sec('2026-09-28T02:00:00Z') },
    { id: 103, orderId: 'PENDING-103', uid: 11, paid: 1,
      status: 0, shippingType: 2, refundStatus: 0, isDel: 0,
      addTime: sec('2026-09-28T03:00:00Z') },
    { id: 104, orderId: 'DELETED-104', uid: 11, paid: 1,
      status: 2, shippingType: 2, refundStatus: 0, isDel: 1 },
    { id: 105, orderId: 'REFUNDED-105', uid: 11, paid: 1,
      status: 2, shippingType: 2, refundStatus: 2, isDel: 0 },
    { id: 106, orderId: 'SHIP-106', uid: 11, paid: 1,
      status: 2, shippingType: 1, refundStatus: 0, isDel: 0 },
  ]);
  await f.db.insert(storeOrderCartInfo).values([
    { id: 501, oid: 101, uid: 11, productId: 71, cartNum: 2,
      unique: 'cart-501', cartInfo: good(71) },
    { id: 502, oid: 102, uid: 12, productId: 72, cartNum: 1,
      unique: 'cart-502', cartInfo: '{bad json' },
  ]);
}, 30_000);
afterEach(async () => { await f?.close(); });

it('maps both prefixes and the badge to writeoff_order.view only', () => {
  for (const base of ['/adminapi', '/api/admin']) {
    for (const route of ['/merchant/verify_order', '/merchant/verify_order/stores',
      '/merchant/verify/spread_info/11', '/merchant/verify_badge']) {
      expect(requiredAdminPermission('GET', `${base}${route}`)).toBe('writeoff_order.view');
    }
    expect(requiredAdminPermission('GET', `${base}/merchant/store_list`)).toBe('store.view');
  }
});

it('preserves status=6 exactly, ordering, safe goods and explicit broken snapshots', async () => {
  const result = await service().list(new URLSearchParams());
  expect(result).toMatchObject({ count: 2, page: 1, limit: 15, badge: [] });
  expect(result.list.map(row => row.id)).toEqual([102, 101]);
  expect(result.list[0]).toMatchObject({ order_id: 'VERIFY-102', status_name: '已删除',
    goods: [], issues: [expect.stringContaining('快照')] });
  expect(result.list[1]).toMatchObject({ uid: 11, nickname: '买家甲',
    spread_nickname: '推荐人', clerk_name: '核销员甲', store_name: '开放门店',
    pay_type_name: '微信支付', status_name: '待评价', pay_price: '25.00',
    goods: [{ name: '购买时商品', spec: '红色', image: '/img/item.png',
      true_price: '12.50', cart_num: 2 }], issues: [] });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain('CARD-DO-NOT-RETURN');
  expect(serialized).not.toContain('SHOULD-NOT-RETURN');
  expect(serialized).not.toContain('{bad json');
});

it('filters Shanghai order add_time with a half-open custom end day, including split and system-deleted rows', async () => {
  await f.db.insert(storeOrder).values([
    { id: 107, orderId: 'END-SECOND', uid: 11, paid: 1, status: 2,
      shippingType: 2, refundStatus: 0, addTime: sec('2026-09-28T15:59:59Z') },
    { id: 108, orderId: 'NEXT-MIDNIGHT', uid: 11, paid: 1, status: 2,
      shippingType: 2, refundStatus: 0, addTime: sec('2026-09-28T16:00:00Z') },
  ]);
  const day = await service().list(new URLSearchParams({ data: '2026/09/28-2026/09/28' }));
  expect(day.list.map(row => row.id)).toEqual([107, 102, 101]);
  expect(day.count).toBe(3);
  expect((await service().list(new URLSearchParams({ data: '2026/09/29-2026/09/29' })))
    .list.map(row => row.id)).toEqual([108]);
  const rolling = await service().list(new URLSearchParams({ data: 'lately7' }),
    sec('2026-09-28T16:00:00Z'));
  expect(rolling.list[0].id).toBe(108);
  expect((await service().list(new URLSearchParams({ store_id: '31' }))).list.map(row => row.id))
    .toEqual([101]);
});

it('covers the full current Shanghai month and year, including future days in that period', async () => {
  await f.db.insert(storeOrder).values([
    { id: 109, orderId: 'MONTH-END', uid: 11, paid: 1, status: 2,
      shippingType: 2, refundStatus: 0, addTime: sec('2026-09-30T15:59:59Z') },
    { id: 110, orderId: 'NEXT-MONTH', uid: 11, paid: 1, status: 2,
      shippingType: 2, refundStatus: 0, addTime: sec('2026-09-30T16:00:00Z') },
    { id: 111, orderId: 'YEAR-END', uid: 11, paid: 1, status: 2,
      shippingType: 2, refundStatus: 0, addTime: sec('2026-12-31T15:59:59Z') },
    { id: 112, orderId: 'NEXT-YEAR', uid: 11, paid: 1, status: 2,
      shippingType: 2, refundStatus: 0, addTime: sec('2026-12-31T16:00:00Z') },
  ]);
  const now = sec('2026-09-28T08:00:00Z');
  const month = await service().list(new URLSearchParams({ data: 'month' }), now);
  expect(month.list.map(row => row.id)).toContain(109);
  expect(month.list.map(row => row.id)).not.toContain(110);
  const year = await service().list(new URLSearchParams({ data: 'year' }), now);
  expect(year.list.map(row => row.id)).toContain(111);
  expect(year.list.map(row => row.id)).not.toContain(112);
});

it('searches exact fields and the old all/title cross-table alternatives', async () => {
  await f.db.insert(userAddress).values({ uid: 12, realName: '地址姓名词', phone: '18800000012' });
  await f.db.insert(storeProduct).values({ id: 71, storeName: '现货标题词', keyword: '库存关键字' });
  await f.db.insert(storeSeckill).values({ id: 61, storeName: '秒杀标题词', info: '秒杀信息词' });
  await f.db.insert(storeBargain).values({ id: 62, title: '砍价标题词', info: '砍价信息词' });
  await f.db.insert(storeCombination).values({ id: 63, storeName: '拼团标题词', info: '拼团信息词' });
  await f.db.insert(storeOrder).values([
    { id: 111, orderId: 'ACT-111', uid: 11, activityId: 61, paid: 1,
      status: 2, shippingType: 2, refundStatus: 0 },
    { id: 112, orderId: 'ACT-112', uid: 11, activityId: 62, paid: 1,
      status: 2, shippingType: 2, refundStatus: 0 },
    { id: 113, orderId: 'ACT-113', uid: 11, activityId: 63, paid: 1,
      status: 2, shippingType: 2, refundStatus: 0 },
  ]);
  const find = async (real_name: string, field_key = 'all') =>
    (await service().list(new URLSearchParams({ real_name, field_key }))).list.map(row => row.id);
  expect(await find('VERIFY-101', 'order_id')).toEqual([101]);
  expect(await find('11', 'uid')).toEqual([101, 113, 112, 111]);
  expect(await find('现货标题词', 'title')).toEqual([101]);
  expect(await find('库存关键字', 'all')).toEqual([101]);
  expect(await find('买家甲', 'all')).toContain(101);
  expect(await find('地址姓名词', 'all')).toEqual([102]);
  expect(await find('秒杀信息词', 'all')).toEqual([111]);
  expect(await find('砍价标题词', 'all')).toEqual([112]);
  expect(await find('拼团标题词', 'all')).toEqual([113]);
  expect(await find('VERIFY-101', 'title')).toEqual([]);
});

it('limits store options and rechecks eligible buyer before returning a minimal promoter', async () => {
  expect(await service().stores()).toEqual({ list: [{ id: 31, name: '开放门店' }] });
  const details = await service().spreadInfo('11');
  expect(details).toMatchObject({ spread: { uid: 20, nickname: '推荐人',
    avatar: '/avatar.png', now_money: '5.25', brokerage_price: '3.00',
    real_name: '私密实名', phone: '13800000020', integral: 7,
    mark: '推荐人备注', birthday: sec('1990-01-01T00:00:00Z') } });
  expect(Object.keys(details.spread ?? {}).sort()).toEqual([
    'avatar', 'birthday', 'brokerage_price', 'integral', 'last_time', 'mark',
    'nickname', 'now_money', 'phone', 'real_name', 'uid',
  ]);
  expect(JSON.stringify(details)).not.toContain('CARD-DO-NOT-RETURN');
  expect(await service().spreadInfo('12')).toEqual({ spread: null });
  await expect(service().spreadInfo('20')).rejects.toThrow('核销订单用户不存在');
});

it('keeps orphaned orders visible and rejects cross-owner or oversized goods snapshots', async () => {
  await f.db.insert(storeOrder).values({ id: 120, orderId: 'ORPHAN-120', uid: 999,
    storeId: 999, clerkId: 999, paid: 1, status: 2, shippingType: 2,
    refundStatus: 0, addTime: sec('2026-09-28T04:00:00Z') });
  await f.db.insert(storeOrderCartInfo).values([
    { id: 520, oid: 120, uid: 11, productId: 71, cartNum: 1,
      unique: 'cart-520', cartInfo: good(71) },
    { id: 521, oid: 120, uid: 999, productId: 71, cartNum: 1,
      unique: 'cart-521', cartInfo: 'x'.repeat(65_537) },
  ]);
  const result = await service().list(new URLSearchParams({ field_key: 'order_id',
    real_name: 'ORPHAN-120' }));
  expect(result.list).toMatchObject([{ id: 120, nickname: '', store_name: '',
    clerk_name: '', goods: [], issues: expect.arrayContaining([
      '下单用户不存在', '核销门店不存在', '核销员不存在',
    ]) }]);
  expect(result.list[0].issues.filter(value => value.includes('商品快照'))).toHaveLength(2);
  expect(JSON.stringify(result)).not.toContain('xxxxx');
});

it('rejects unknown, duplicate, oversized and malformed searches before querying', async () => {
  for (const parameters of [new URLSearchParams({ page: '668' }),
    new URLSearchParams({ limit: '51' }),
    new URLSearchParams({ data: '2026/02/30-2026/03/01' }),
    new URLSearchParams({ data: '2026/09/29-2026/09/28' }),
    new URLSearchParams({ real_name: 'x'.repeat(81) }),
    new URLSearchParams({ field_key: 'uid', real_name: 'not-number' }),
    new URLSearchParams({ field_key: 'unsupported' }),
    new URLSearchParams({ unknown: '1' }),
    new URLSearchParams('page=1&page=2')]) {
    await expect(service().list(parameters)).rejects.toThrow();
  }
});
