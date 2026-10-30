import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeBargain, storeBargainUser, storeBargainUserHelp, storeOrder, storeOrderCartInfo, storeProduct, user, userAddress } from '@/models/schema';
export const bargainRecordTables = [storeBargain, storeBargainUser, storeBargainUserHelp, storeOrder, storeOrderCartInfo, storeProduct, user, userAddress];
export const bargainRecordEpoch = Date.parse('2026-09-25T16:00:00Z') / 1000;
export async function seedBargainRecords(db: DbClient) {
  await db.insert(storeBargain).values([
    { id: 801, productId: 870, title: '砍价%_甲', storeName: '砍价商品', info: '活动内容', people: 3, stopTime: new Date('2030-01-01T00:00:00Z') },
    { id: 802, productId: 870, title: '已过期邻活动', people: 1, stopTime: new Date('2020-01-01T00:00:00Z'), isDel: 1 },
    { id: 803, productId: 870, title: '三次发起一次支付', people: 2 },
  ]);
  await db.insert(user).values([{ uid: 810, account: 'bargain-record-alice', nickname: '用户%_甲', phone: '13800000810', avatar: '/static/810.png' },
    { uid: 811, account: 'bargain-record-deleted', nickname: '已注销乙', phone: '13800000811', deleteTime: new Date('2026-01-01Z'), avatar: '/api/assets/123?signature=unknown' }]);
  const record = { bargainId: 801, uid: 810, bargainPrice: '20.00', price: '8.12', bargainPriceMin: '5.00', addTime: bargainRecordEpoch };
  await db.insert(storeBargainUser).values([
    { ...record, id: 8101, status: 1 }, { ...record, id: 8102, status: 3, uid: 811 },
    { ...record, id: 8103, status: 4, uid: 812, isDel: 1, addTime: bargainRecordEpoch + 86399 },
    { ...record, id: 8104, bargainId: 802, status: 1, addTime: bargainRecordEpoch + 86400 },
    { ...record, id: 8105, bargainId: 899, uid: 812 },
    ...[8106,8107,8108].map(id => ({ ...record, id, bargainId: 803 })),
  ]);
  const help = { bargainId: 801, bargainUserId: 8101, uid: 810, price: '0.10', addTime: bargainRecordEpoch };
  await db.insert(storeBargainUserHelp).values([
    { ...help, id: 8201, type: 1 }, { ...help, id: 8202, type: 0, uid: 811 },
    { ...help, id: 8203, type: 0, uid: 811 }, { ...help, id: 8204, type: 0, uid: 812, bargainUserId: 8102 },
    { ...help, id: 8205, type: 0, bargainId: 802 }, // inconsistent legacy foreign activity cannot inflate this record's help count/detail
  ]);
  const order = { type: 2, activityId: 801, paid: 1, uid: 810, addTime: bargainRecordEpoch, realName: '本地联系人', userPhone: '13900000810', totalNum: 1 };
  await db.insert(storeOrder).values([
    { ...order, id: 8301, orderId: 'BARGAIN-8301', unique: 'bargain-record-8301', payPrice: '10.10' },
    { ...order, id: 8302, orderId: 'BARGAIN-8302', unique: 'bargain-record-8302', pid: -1, payPrice: '20.20', refundStatus: 2, isSystemDel: 1 },
    { ...order, id: 8303, orderId: 'BARGAIN-8303', unique: 'bargain-record-8303', uid: 811, paid: 0, payPrice: '100.00' },
    { ...order, id: 8304, orderId: 'BARGAIN-8304', unique: 'bargain-record-8304', pid: 8301, payPrice: '100.00' },
    { ...order, id: 8305, orderId: 'BARGAIN-8305', unique: 'bargain-record-8305', activityId: 802, payPrice: '100.00' },
    { ...order, id: 8306, orderId: 'BARGAIN-8306', unique: 'bargain-record-8306', type: 3, payPrice: '100.00' },
    { ...order, id: 8307, orderId: 'BARGAIN-8307', unique: 'bargain-record-8307', activityId: 803, payPrice: '0.10' },
  ]);
  await db.insert(userAddress).values([{ id: 8401, uid: 810, realName: '地址联系人', phone: '13711112222' }, { id: 8402, uid: 810, realName: '地址联系人', phone: '13711112222' }]);
  await db.insert(storeProduct).values({ id: 870, storeName: '原商品%_', keyword: '商品搜索关键词' });
  await db.insert(storeOrderCartInfo).values([{ id: 8501, oid: 8301, uid: 810, productId: 870, unique: 'bargain-cart-8501' }, { id: 8502, oid: 8301, uid: 810, productId: 870, unique: 'bargain-cart-8502' }]);
}
export async function bargainRecordsSnapshot(db: DbClient) {
  const state: Record<string, unknown> = {};
  for (const name of ['store_bargain','store_bargain_user','store_bargain_user_help','store_order','store_order_cart_info','store_product','user','user_address'])
    state[name] = await db.execute(sql.raw(`SELECT to_jsonb(t) AS row FROM public."${name}" t ORDER BY to_jsonb(t)::text`));
  return state;
}
