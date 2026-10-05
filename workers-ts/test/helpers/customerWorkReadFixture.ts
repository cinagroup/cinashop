import { SQL, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import type { AppVariables, Env } from '../../src/env';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { user, storeService, storeOrder, storeOrderCartInfo, storeOrderRefund, storeProduct, storeProductLog, systemConfig, systemAttachment, systemSupplier, systemStore, systemStoreStaff, deliveryService,expressCompany,storePink,storeDeliveryOrder,storeConfig,orderWaybillJob,orderWaybillJobAction } from '../../src/models/schema';
import { customerCityDeliveryJob,customerCityDeliveryAttempt,customerCityDeliveryBinding } from '../../src/models/schema/customer_city_delivery';
import { storeOrderRefundSplit, storeOrderFulfillmentBranch } from '../../src/models/schema/order_refund_split';
import { customerWorkRuntimePrivilegePlan } from '../../src/migrations/customerWorkRuntimePrivilegePlan';
import { runCustomerWaybillActor } from '../../src/migrations/runCustomerWaybillActor';
import { installCustomerCityDelivery } from '../../src/migrations/customerCityDelivery';
import { authMiddleware } from '../../src/middleware/auth';
import * as Controller from '../../src/controllers/api/v1/CustomerWorkController';
import { CustomerWorkReadService } from '../../src/services/customer-work/CustomerWorkReadService';
import type { CustomerWorkActor } from '../../src/services/customer-work/CustomerWorkScope';
import { md5 } from '../../src/utils/jwt';
import { sequenceRunnerDatabase } from './kefuSequenceRunnerDatabase';
import { observeIntegralReadDb } from './integralProductReadFixture';

export const customerReadNow = Math.floor(Date.UTC(2026, 9, 4, 4) / 1000);
export const customerReadEnv = { APP_KEY: 'owned-customer-work-read-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} } } as unknown as Env;
export const observeCustomerReadDb = observeIntegralReadDb;
export const customerReadTables = [user, storeService, storeOrder, storeOrderCartInfo, storeOrderRefund, storeProduct, storeProductLog, systemConfig, systemAttachment, systemSupplier, systemStore, systemStoreStaff, deliveryService, storeOrderRefundSplit, storeOrderFulfillmentBranch,expressCompany,storePink,storeDeliveryOrder,storeConfig,orderWaybillJob,orderWaybillJobAction,customerCityDeliveryJob,customerCityDeliveryAttempt,customerCityDeliveryBinding];
const ident = (value: string) => { if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid owned customer-work fixture identifier'); return `"${value}"`; };
export async function customerWorkReadFixture() {
  const f = await sequenceRunnerDatabase();
  if (f.format !== 'pg16' || !f.withRuntimeRole) { await f.close(); throw Error('Customer work reader requires native PG16 independent LOGIN'); }
  try {
    const dialect = new PgDialect();
    for (const table of customerReadTables.filter(t=>!['order_waybill_job','order_waybill_job_action','customer_city_delivery_job','customer_city_delivery_attempt','customer_city_delivery_binding'].includes(getTableConfig(t).name))) { const definition = getTableConfig(table), columns = definition.columns.map(column => { const initial = column.default, value = initial === undefined ? '' : ` DEFAULT ${initial instanceof SQL ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`; return `${ident(column.name)} ${column.getSQLType()}${value}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}${column.isUnique ? ' UNIQUE' : ''}`; }); await f.exec(`CREATE TABLE public.${ident(definition.name)} (${columns.join(',')})`); }
    await f.exec(readFileSync(new URL('../../migrations/0091_electronic_waybill_outbox.sql',import.meta.url),'utf8'));await runCustomerWaybillActor(f.db);await installCustomerCityDelivery(f.db,{maintenance:true});
    const actor = (uid = 101): CustomerWorkActor => ({ uid, auth_version: md5('owned-customer-password'), expires_at: Math.floor(Date.now() / 1000) + 3600 });
    const order = (id: number, values: Partial<typeof storeOrder.$inferInsert> = {}) => ({ id, orderId: `customer-order-${id}`, unique: `customer-unique-${id}`, uid: 201, realName: '实际收件人', userPhone: '13900000201', userAddress: '实际收件地址', paid: 1, status: 0, shippingType: 1, totalNum: 1, totalPrice: '12.34', payPrice: '12.34', payType: 'yue', refundStatus: 0, addTime: customerReadNow, ...values });
    const cart = (id: number, values: Partial<typeof storeOrderCartInfo.$inferInsert> = {}) => ({ id, oid: id, uid: 201, cartId: `cart-${id}`, unique: `cart-unique-${id}`, productId: 1, productType: 0, cartNum: 1, splitSurplusNum: 1, cartInfo: JSON.stringify({ productInfo: { id: 1, store_name: '真实商品快照', image: '/api/assets/41', price: '12.34', attrInfo: { suk: '真实规格', price: '12.34' } }, truePrice: '12.34', vip_truePrice: '0.00', sum_true_price: '12.34' }), ...values });
    const refund = (id: number, values: Partial<typeof storeOrderRefund.$inferInsert> = {}) => ({ id, storeOrderId: 1, uid: 201, orderId: `customer-refund-${id}`, refundType: 0, refundNum: 1, refundPrice: '1.00', addTime: customerReadNow, cartInfo: JSON.stringify([{ cart_id: 'cart-1', cart_num: 1 }]), ...values });
    const reset = async () => {
      for (const table of [...customerReadTables].reverse()) await f.db.delete(table);
      await f.db.insert(user).values([...Array.from({ length: 9 }, (_, i) => ({ uid: 101 + i, account: `work-actor-${i}`, pwd: 'owned-customer-password', nickname: `手机经营员${i}`, phone: `1390000010${i}`, status: 1, isDel: 0 })), { uid: 201, account: 'actual-customer', pwd: 'PRIVATE WALLET PASSWORD', nowMoney: '202.00', nickname: '实际客户', phone: '13900000201', avatar: '/api/assets/51' }, { uid: 202, account: 'second-customer', pwd: 'PRIVATE SECOND PASSWORD', nickname: '第二客户' }]);
      await f.db.insert(storeService).values([{ id: 1, uid: 101, account: 'mobile-work-only', customer: 1, accountStatus: 1, status: 0 }, { id: 2, uid: 102, account: 'chat-only', customer: 0, accountStatus: 1, status: 1 }, { id: 3, uid: 106, account: 'expired-work', customer: 1, accountStatus: 0 }, { id: 4, uid: 107, account: 'deleted-work', customer: 1, isDel: 1 }]);
      await f.db.insert(systemStore).values({ id: 77, name: '真实门店', isStore: 1, isShow: 1 });
      await f.db.insert(systemStoreStaff).values([{ id: 1, uid: 103, storeId: 77, status: 1, isManager: 1, orderStatus: 1 }, { id: 2, uid: 104, storeId: 77, status: 1, verifyStatus: 1 }]);
      await f.db.insert(deliveryService).values({ id: 1, uid: 105, nickname: '配送员', status: 1, type: 0, relationId: 0 });
      await f.db.insert(systemSupplier).values({ id: 88, supplierName: '真实供应商', isShow: 1, isDel: 0 });
      await f.db.insert(storeProduct).values({ id: 1, storeName: '真实搜索商品', keyword: '商品词', image: '/api/assets/41', price: '12.34', stock: 5, isShow: 1, isVerify: 1 });
      await f.db.insert(systemAttachment).values([{ attId: 41, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/admin/1/product.png', attDir: '/api/assets/41', attType: 'image/png' }, { attId: 51, type: 3, relationId: 201, moduleType: 3, fileType: 1, imageType: 8, name: 'attachments/user/201/avatar.png', attDir: '/api/assets/51', attType: 'image/png' }, { attId: 52, type: 3, relationId: 202, moduleType: 3, fileType: 1, imageType: 8, name: 'attachments/user/202/PRIVATE.png', attDir: '/api/assets/52', attType: 'image/png' }]);
      await f.db.insert(systemConfig).values(['balance_func_status', 'yue_pay_status', 'pay_weixin_open', 'ali_pay_status'].map((menuName, index) => ({ id: 10 + index, menuName, value: '1' })));
      await f.db.insert(storeOrder).values(order(1)); await f.db.insert(storeOrderCartInfo).values(cart(1));
    };
    await reset();
    const app = async <T>(callback: (db: DbClient, role: string) => Promise<T>) => f.withRuntimeRole!(async peer => {
      const plan = customerWorkRuntimePrivilegePlan(); for (const table of customerReadTables) { const name = getTableConfig(table).name; if (!plan.tables[name]?.includes('SELECT')) throw Error(`Actual app cannot SELECT customer reader table ${name}`); await f.exec(`GRANT SELECT ON public.${ident(name)} TO ${ident(peer.role)}`); }
      const [identity] = await peer.exec(`SELECT current_user AS role,session_user AS session,(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated,has_table_privilege(current_user,'store_order','UPDATE') AS writes`);
      if (identity.role !== peer.role || identity.session !== peer.role || identity.elevated !== false || identity.writes !== false) throw Error('Customer reader must use normal SELECT-only independent LOGIN');
      return callback(peer.db, peer.role);
    });
    const reader = (db: DbClient) => new CustomerWorkReadService(createContainerFromDb(db), customerReadEnv);
    const http = (db: DbClient) => { const h = new Hono<{ Bindings: Env; Variables: AppVariables }>(); h.use('*', async (c, next) => { c.set('container', createContainerFromDb(db)); await next(); }); h.use('*', authMiddleware({ force: true })); h.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }, 400)); h.get('/context', Controller.context); h.get('/overview', Controller.overview); h.get('/statistics', Controller.statistics); h.get('/trend', Controller.trend); h.get('/statistics/orders', Controller.daily); h.get('/orders', Controller.orders); h.get('/orders/:id', Controller.orderDetail); h.get('/refunds', Controller.refunds); h.get('/refunds/:id', Controller.refundDetail); h.get('/orders/:id/logistics', Controller.logistics); return h; };
    return { ...f, reset, actor, order, cart, refund, app, reader, http, env: customerReadEnv };
  } catch (error) { await f.close(); throw error; }
}
