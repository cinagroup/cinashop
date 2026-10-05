import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { financePostgres } from './helpers/financePostgres';
import { createContainerFromDb } from '../src/lib/di';
import { user, userRecharge } from '../src/models/schema';
import { AdminRechargeOrderService } from '../src/services/admin/AdminRechargeOrderService';
import { requiredAdminPermission } from '../src/services/admin/AdminPermissionService';

let f: Awaited<ReturnType<typeof financePostgres>>;
const service = () => new AdminRechargeOrderService(createContainerFromDb(f.db));
const at = (minute: number, second = 0) => Math.floor(Date.UTC(2026, 8, 28, 2, minute, second) / 1000);

beforeEach(async () => {
  f = await financePostgres([user, userRecharge]);
  await f.db.insert(user).values([
    { uid: 11, nickname: 'Alpha buyer', realName: '王一', phone: '13800000011', avatar: '/alpha.png' },
    { uid: 12, nickname: 'Beta buyer', realName: '李二', phone: '13800000012',
      deleteTime: new Date('2026-09-29T00:00:00Z') },
  ]);
  await f.db.insert(userRecharge).values([
    { id: 101, uid: 11, orderId: 'czPAID101', price: '10.00', givePrice: '2.00',
      refundPrice: '2.00', paid: 1, rechargeType: 'routine', payTime: at(5, 1), addTime: at(5, 0),
      tradeNo: 'private-trade-101', channelType: 'routine', remarks: 'private-note-101' },
    { id: 102, uid: 12, orderId: 'czWAIT102', price: '20.00', paid: 0,
      rechargeType: 'weixin', addTime: at(5, 59) },
    { id: 103, uid: 11, orderId: 'czPAID103', price: '30.00', paid: 1,
      rechargeType: 'weixin', payTime: at(6, 1), addTime: at(6, 0) },
    { id: 104, uid: 777, orderId: 'czORPHAN104', price: '5.00', paid: 0,
      rechargeType: 'alipay', addTime: at(7, 0) },
  ]);
}, 30_000);
afterEach(async () => { await f?.close(); });

it('requires an independent recharge-order view capability on both Admin prefixes', () => {
  for (const base of ['/adminapi', '/api/admin']) {
    expect(requiredAdminPermission('GET', `${base}/finance/recharge-orders`)).toBe('recharge_order.view');
    expect(requiredAdminPermission('GET', `${base}/finance/recharge-orders/stats`)).toBe('recharge_order.view');
    expect(requiredAdminPermission('GET', `${base}/finance/recharge-orders/101`)).toBe('recharge_order.view');
    expect(requiredAdminPermission('GET', `${base}/marketing/recharge-quotas`)).toBe('recharge_quota.view');
    expect(requiredAdminPermission('GET', `${base}/bill/list`)).toBe('bill.view');
  }
});

it('lists paid and unpaid orders, strict Shanghai minute filtering, keyword matches and orphan rows', async () => {
  const all = await service().list(new URLSearchParams({ limit: '2' }));
  expect(all).toMatchObject({ count: 4, page: 1, limit: 2,
    list: [{ id: 104, user_missing: true, nickname: '', avatar: '', paid: 0,
      issues: ['关联用户不存在'] }, { id: 103, paid: 1 }] });
  expect(JSON.stringify(all)).not.toContain('private-trade-101');
  const second = await service().list(new URLSearchParams({ page: '2', limit: '2' }));
  expect(second.list.map(row => row.id)).toEqual([102, 101]);
  expect(second.list[0]).toMatchObject({ user_deleted: true, paid_type: '待付款' });
  const minute = await service().list(new URLSearchParams({
    start_time: '2026-09-28 10:05', end_time: '2026-09-28 10:05' }));
  expect(minute.list.map(row => row.id)).toEqual([102, 101]);
  expect((await service().list(new URLSearchParams({ paid: '0' }))).list.map(row => row.id))
    .toEqual([104, 102]);
  for (const keyword of ['Alpha buyer', '王一', '13800000011', 'czPAID101', '11']) {
    expect((await service().list(new URLSearchParams({ keyword }))).list.map(row => row.id))
      .toContain(101);
  }
  expect((await service().list(new URLSearchParams({ keyword: 'czORPHAN104' }))).count).toBe(1);
});

it('returns only whitelisted detail fields and reports historical damage without losing orphan rows', async () => {
  const detail = await service().detail(101);
  expect(detail).toMatchObject({ id: 101, uid: 11, order_id: 'czPAID101',
    price: '10.00', give_price: '2.00', refund_price: '2.00', paid: 1,
    trade_no: 'private-trade-101', channel_type: 'routine', remarks: 'private-note-101',
    nickname: 'Alpha buyer', phone: '13800000011', real_name: '王一', issues: [] });
  expect(Object.keys(detail).sort()).toEqual([
    'add_time', 'avatar', 'channel_type', 'give_price', 'id', 'issues', 'nickname',
    'order_id', 'paid', 'paid_type', 'pay_time', 'phone', 'price', 'real_name',
    'recharge_type', 'recharge_type_label', 'refund_price', 'remarks', 'staff_id',
    'store_id', 'trade_no', 'uid', 'user_deleted', 'user_missing',
  ].sort());
  expect(await service().detail(104)).toMatchObject({ nickname: '', avatar: '',
    phone: '', real_name: '', user_deleted: false, user_missing: true });
  await f.db.update(userRecharge).set({ refundPrice: '99.00', payTime: 0 })
    .where(eq(userRecharge.id, 101));
  expect((await service().detail(101)).issues).toEqual([
    '充值或退款金额异常', '已支付订单缺少支付时间' ]);
  await f.db.update(userRecharge).set({ paid: 2 }).where(eq(userRecharge.id, 101));
  expect(await service().detail(101)).toMatchObject({ paid: 2, paid_type: '状态异常',
    issues: ['支付状态异常', '充值或退款金额异常'] });
  await f.db.update(user).set({ avatar: 'javascript:alert(1)' }).where(eq(user.uid, 11));
  expect((await service().detail(101)).avatar).toBe('');
  await f.db.update(user).set({ avatar: '/\\evil.example/avatar.png' }).where(eq(user.uid, 11));
  expect((await service().detail(101)).avatar).toBe('');
  await expect(service().detail(0)).rejects.toThrow('ID无效');
  await expect(service().detail(999)).rejects.toThrow('不存在');
});

it('uses the old four paid-order sums even when the list filter selects unpaid orders', async () => {
  expect(await service().stats(new URLSearchParams({ paid: '0' }))).toEqual({
    sum_price: '40.00', sum_refund_price: '2.00',
    sum_routine_price: '10.00', sum_weixin_price: '30.00',
  });
  expect(await service().stats(new URLSearchParams({
    start_time: '2026-09-28 10:05', end_time: '2026-09-28 10:05' }))).toEqual({
    sum_price: '10.00', sum_refund_price: '2.00',
    sum_routine_price: '10.00', sum_weixin_price: '0.00',
  });
  await expect(service().list(new URLSearchParams({ start_time: '2026-09-28 10:05' })))
    .rejects.toThrow('成对');
  await expect(service().list(new URLSearchParams({
    start_time: '2026-09-28 10:05', end_time: '2027-10-01 10:05' })))
    .rejects.toThrow('366天');
  await expect(service().list(new URLSearchParams({
    start_time: '2038-01-19 11:13', end_time: '2038-01-19 11:14' })))
    .rejects.toThrow('超出时间范围');
  expect((await service().list(new URLSearchParams({
    start_time: '2038-01-19 11:13', end_time: '2038-01-19 11:13' }))).count).toBe(0);
  await expect(service().stats(new URLSearchParams({ keyword: 'x', extra: '1' })))
    .rejects.toThrow('未知');
  await expect(service().list(new URLSearchParams({ page: '10001' })))
    .rejects.toThrow('分页');
});
