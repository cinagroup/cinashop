import { eq, SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { storeOrder, storeOrderCartInfo, storeProduct, user, userAddress, storeSeckill, storeBargain, storeCombination } from '@/models/schema';
import { supplierOrderDistributionFixture } from './supplierOrderDistribution';

export const supplierOrderFilterIds = { single: 100, root: 200, first: 201, second: 202, platform: 300, allocated: 301, foreign: 900,
  typeStart: 110, currentProduct: 110, seckill: 111, bargain: 112, combination: 113, newcomer: 117,
  lottery: 118, unpaid: 119, shipped: 120, received: 121, completed: 122, deleted: 123, systemDeleted: 124,
  pickup: 125, shippingThree: 126, partial: 127 } as const;
/** Owned synthetic PG16 only. Commission SELECT, never author/lock rights, on
 * the actual extra current search catalogs. Mature fixtures remain unchanged. */
export async function supplierOrderFiltersFixture() {
  const f = await supplierOrderDistributionFixture();
  try {
    const extra = [user, userAddress, storeSeckill, storeBargain, storeCombination], dialect = new PgDialect();
    for (const table of extra) {
      const definition = getTableConfig(table), columns = definition.columns.map(column => {
        const value = column.default, initial = value === undefined ? '' : ` DEFAULT ${value instanceof SQL ? dialect.sqlToQuery(value).sql : dialect.sqlToQuery(sql`${value}`.inlineParams()).sql}`;
        return `"${column.name}" ${column.getSQLType()}${initial}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
      });
      await f.exec(`CREATE TABLE public."${definition.name}" (${columns.join(',')})`);
    }
    await f.db.insert(user).values([{ uid: 11, account: 'filters-owned-buyer', nickname: '当前买家昵称', phone: '13955556666' },
      { uid: 12, account: 'filters-foreign-buyer', nickname: '无关买家', phone: '13800000012' }]);
    await f.db.insert(userAddress).values({ id: 11, uid: 11, realName: '地址联系人', phone: '13999990000', detail: 'PRIVATE-ADDRESS-NOT-RETURNED' });
    await f.db.update(storeProduct).set({ storeName: '当前筛选商品', keyword: '目录关键词' }).where(eq(storeProduct.id, 70));
    await f.db.insert(storeProduct).values({ id: 80, type: 2, relationId: 8, storeName: '外店私有商品', keyword: '外店目录' });
    await f.db.insert(storeSeckill).values({ id: 71, type: 2, relationId: 7, storeName: '当前秒杀活动', info: '秒杀检索说明' });
    await f.db.insert(storeBargain).values({ id: 71, type: 2, relationId: 7, title: '当前砍价活动', info: '砍价检索说明' });
    await f.db.insert(storeCombination).values({ id: 71, type: 2, relationId: 7, storeName: '当前拼团活动', info: '拼团检索说明' });
    const [base] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, 100));
    const payments = ['weixin', 'yue', 'offline', 'alipay', 'integral'];
    await f.db.insert(storeOrder).values(Array.from({ length: 9 }, (_, type) => ({ ...base, id: 110 + type, type,
      orderId: 'FILTER-TYPE-' + type, realName: '筛选客户' + type, totalNum: type + 1, addTime: 1700000000 + type * 100,
      status: type === 7 ? 4 : 0, refundStatus: type === 7 ? 3 : 0, payType: payments[type === 7 ? 2 : type % 5], activityId: 71 })));
    const other = (id: number, changes: Partial<typeof storeOrder.$inferInsert> = {}) => ({ ...base, id, orderId: 'FILTER-STATE-' + id,
      realName: '状态客户' + id, addTime: 1700001000 + id, ...changes });
    await f.db.insert(storeOrder).values([other(119, { paid: 0, status: 0 }), other(120), other(121, { status: 2 }), other(122, { status: 3 }),
      other(123, { isDel: 1 }), other(124, { isSystemDel: 1 }), other(125, { status: 5, shippingType: 2 }),
      other(126, { status: 5, shippingType: 3 }), other(127, { status: 4 })]);
    await f.db.insert(storeOrderCartInfo).values({ id: 1101, oid: 110, uid: 11, type: 2, relationId: 7, productId: 70,
      cartId: '1101', cartNum: 1, cartInfo: JSON.stringify({ product: { id: 70, storeName: '冻结历史商品标题' }, sku: { suk: '冻结规格' } }) });
    const grantReader = async (role: string) => {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(role)) throw Error('Unowned filter LOGIN');
      await f.grantReader(role);
      await f.exec(`GRANT SELECT ON public."user",public.user_address,public.store_product,public.store_seckill,public.store_bargain,public.store_combination TO "${role}"`);
    };
    type Peer = Parameters<Parameters<typeof f.withReader>[0]>[0];
    const withReader = <T>(work: (peer: Peer) => Promise<T>) => f.withReader(async peer => { await grantReader(peer.role); return work(peer); });
    const visibleIds = [100, 102, 103, 104, ...Array.from({ length: 18 }, (_, index) => 110 + index).filter(id => id !== 124), 201, 202, 301].sort((a, b) => b - a);
    return { ...f, ids: supplierOrderFilterIds, withReader, grantReader, visibleIds,
      expected: { typeIds: Array.from({ length: 9 }, (_, type) => 110 + type), currentTitleIds: [110, 100],
        rootNumber: 'tracking-own-200', platformNumber: 'tracking-own-300', currentTitle: '当前筛选商品',
        userNickname: '当前买家昵称', addressName: '地址联系人', comboQuery: { type: '7', business_status: '1', pay_type: '3',
          field_key: 'real_name', real_name: '筛选客户7', start_time: '1700000700', end_time: '1700000700' } } };
  } catch (error) { await f.close(); throw error; }
}
