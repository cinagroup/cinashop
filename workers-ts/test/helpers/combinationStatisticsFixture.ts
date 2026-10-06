import { sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { storeCombination, storePink, storeOrder, storeOrderCartInfo, storeProduct, user, userAddress } from '../../src/models/schema';
import { AdminCombinationStatisticsService } from '../../src/services/admin/AdminCombinationStatisticsService';
import { financePostgres } from './financePostgres';

export const statisticsTables = [storeCombination, storePink, storeOrder, storeOrderCartInfo, storeProduct, user, userAddress];
export const statisticsEpoch = (value: string) => Math.floor(Date.parse(value) / 1000);
/** All identities are synthetic and disjoint from the formal refund fixture.
 * Reuse this projection data under PGlite and commissioned native Admin alike. */
export async function seedCombinationStatistics(db: DbClient) {
  await db.insert(storeCombination).values([
    { id: 501, productId: 700, storeName: '活动%_甲', info: '组合活动简介', people: 3 },
    { id: 502, productId: 701, storeName: '相邻活动', people: 2 },
    { id: 503, productId: 700, storeName: '删除的活动', isDel: 1 },
  ]);
  await db.insert(user).values([
    { uid: 101, account: 'statistics-alice', nickname: '用户甲', phone: '13800000101' },
    { uid: 102, account: 'statistics-deleted', nickname: '已注销乙', phone: '13800000102', deleteTime: new Date('2026-09-25T00:00:00Z') },
    { uid: 104, account: 'statistics-fourth', nickname: '用户丁', phone: '13800000104' },
  ]);
  const start = statisticsEpoch('2026-09-25T16:00:00Z'), end = statisticsEpoch('2026-09-26T15:59:59Z');
  const pink = { combinationId: 501, productId: 700, people: 3, stopTime: new Date('2026-09-25T00:00:00Z'), price: '5.00', addTime: start };
  await db.insert(storePink).values([
    { ...pink, id: 9001, uid: 101, nickname: '团长%_', avatar: '/images/statistics.png', memberCount: 99, orderId: 'BUSINESS-9101', orderIdKey: 'key-one' },
    { ...pink, id: 9002, uid: 101, nickname: '重复参团', kId: 9001, orderId: 'BUSINESS-9102', orderIdKey: 'key-two', addTime: start + 1 },
    { ...pink, id: 9003, uid: 0, nickname: '虚拟补员', kId: 9001, isVirtual: 1, orderId: '0', orderIdKey: '0', price: '0.00' },
    { ...pink, id: 9004, uid: 102, nickname: '退款团员', kId: 9001, isRefund: 9001 },
    { ...pink, id: 9005, uid: 102, nickname: '退款成功团长', status: 2, isRefund: 9005, orderId: 'BUSINESS-9103', orderIdKey: 'key-three', addTime: end + 1 },
    { ...pink, id: 9006, uid: 103, nickname: '用户已缺失', kId: 9005 },
    { ...pink, id: 9007, uid: 0, nickname: '历史虚拟团长', isVirtual: 1, status: 2, addTime: end },
    { ...pink, id: 9008, uid: 101, nickname: '另一个团', status: 3, addTime: end },
    { ...pink, id: 9009, uid: 104, combinationId: 502, productId: 701, nickname: '相邻团', status: 2, addTime: end },
    { ...pink, id: 9010, uid: 104, combinationId: 502, productId: 701, nickname: '恶意跨活动子行', kId: 9001 },
    { ...pink, id: 9011, uid: 103, combinationId: 999, nickname: '孤儿活动', avatar: '/api/assets/123?signature=unknown' },
    { ...pink, id: 9012, uid: 104, nickname: '部分发货团员', kId: 9001, orderId: 'BUSINESS-9109', orderIdKey: '9109', addTime: start + 1 },
  ]);
  const order = { type: 3, activityId: 501, paid: 1, uid: 101, pinkId: 9001, addTime: start, realName: '订单联系人', userPhone: '13900000000', totalNum: 1 };
  await db.insert(storeOrder).values([
    { ...order, id: 9101, orderId: 'BUSINESS-9101', unique: 'key-one', payPrice: '10.10' },
    { ...order, id: 9102, orderId: 'BUSINESS-9102', unique: 'key-two', payPrice: '20.20', pid: -1, isSystemDel: 1 },
    { ...order, id: 9103, orderId: 'BUSINESS-9103', unique: 'key-three', uid: 102, pinkId: 9005, payPrice: '30.30', refundStatus: 2, refundType: 6 },
    { ...order, id: 9104, orderId: 'BUSINESS-9104', unique: 'key-four', uid: 0, pinkId: 9007, payPrice: '40.40' },
    { ...order, id: 9105, orderId: 'BUSINESS-9105', unique: 'key-five', uid: 104, paid: 0, payPrice: '50.50' },
    { ...order, id: 9106, orderId: 'BUSINESS-9106', unique: 'key-six', pid: 9101, payPrice: '60.60' },
    { ...order, id: 9107, orderId: 'BUSINESS-9107', unique: 'key-seven', type: 1, payPrice: '70.70' },
    { ...order, id: 9108, orderId: 'BUSINESS-9108', unique: 'key-eight', activityId: 502, uid: 104, pinkId: 9009, payPrice: '80.80' },
    { ...order, id: 9109, orderId: 'BUSINESS-9109', unique: 'key-nine', uid: 104, status: 4, shippingType: 3, payPrice: '9.09' },
  ]);
  await db.insert(userAddress).values([
    { id: 9401, uid: 101, realName: '地址联系人', phone: '13711112222' },
    { id: 9402, uid: 101, realName: '地址联系人', phone: '13711112222' },
  ]);
  await db.insert(storeProduct).values([{ id: 700, storeName: '商品标题%_', keyword: '搜索商品关键字', stock: 10 },
    { id: 701, storeName: '相邻商品', stock: 10 }]);
  await db.insert(storeOrderCartInfo).values([{ id: 9301, oid: 9101, uid: 101, productId: 700, unique: 'stat-cart-1' },
    { id: 9302, oid: 9101, uid: 101, productId: 700, unique: 'stat-cart-2' }]);
}
export async function statisticsSnapshot(db: DbClient) {
  const rows: Record<string, unknown> = {};
  for (const table of ['store_combination', 'store_pink', 'store_order', 'store_order_cart_info', 'store_product', 'user', 'user_address'])
    rows[table] = await db.execute(sql.raw(`SELECT to_jsonb(t) AS row FROM public."${table}" t ORDER BY to_jsonb(t)::text`));
  return rows;
}
export async function combinationStatisticsFixture() {
  const f = await financePostgres(statisticsTables, { namespace: 'public' });
  try {
    await seedCombinationStatistics(f.db);
    return { ...f, service: new AdminCombinationStatisticsService(createContainerFromDb(f.db)), snapshot: () => statisticsSnapshot(f.db) };
  } catch (error) { await f.close(); throw error; }
}
