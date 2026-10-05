import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppVariables, Env } from '../../src/env';
import { createContainerFromDb } from '../../src/lib/di';
import { storeActivity, storeProduct, storeProductAttr, storeProductAttrResult, storeProductAttrValue, storeProductDescription,
  storeProductSkuRetirementLog, storeSeckill, storeSeckillTime, systemAdmin, systemAttachment, systemLog, systemRole, systemSupplier, shippingTemplates } from '../../src/models/schema';
import { storeProductCategory, storeProductLabel, storeProductRelation } from '../../src/models/schema';
import * as Activity from '../../src/controllers/api/v1/AdminSeckillActivityController';
import { AdminSeckillActivityService } from '../../src/services/admin/AdminSeckillActivityService';
import { adminAuthMiddleware } from '../../src/middleware/admin-auth';
import { ApiException } from '../../src/utils/errors';
import { createToken, md5 } from '../../src/utils/jwt';
import { financePostgres } from './financePostgres';
import { seckillTimeReferenceLockFixture } from './seckillTimeReferenceLockFixture';

export async function seckillActivityFixture() {
  const f = await seckillTimeReferenceLockFixture({ ...await financePostgres([storeActivity, storeProduct, storeProductAttr, storeProductAttrResult,
    storeProductAttrValue, storeProductDescription, storeProductSkuRetirementLog, storeSeckill, storeSeckillTime, systemAdmin,
    systemAttachment, systemLog, systemRole, systemSupplier, shippingTemplates, storeProductCategory, storeProductLabel, storeProductRelation], { namespace: 'public' }), format: process.env.TEST_FINANCE_POSTGRES_URL ? 'pg16' : 'pglite' });
  try {
    const container = createContainerFromDb(f.db), env = { APP_KEY: 'parent-activity-fixture-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
    await f.db.insert(systemAttachment).values({ attId: 42, type: 1, relationId: 0, moduleType: 1, fileType: 1, attDir: '/api/assets/42' });
    await f.db.insert(storeSeckillTime).values([{ id: 1, title: '全天', startTime: '00:00', endTime: '24:00', status: 1 },
      { id: 2, title: '夜场', startTime: '1800', endTime: '2000', status: 0 }]);
    await f.db.insert(storeProduct).values([101, 102].map(id => ({ id, storeName: `基础${id}`, storeInfo: '服务端简介', stock: 100,
      image: '/images/product.png', sliderImage: '["/images/product.png"]', type: 0, relationId: 0, productType: 0,
      isShow: 1, isDel: 0, isVerify: 1, unitName: '件', freight: 1, deliveryType: '1', price: '10.00', otPrice: '20.00' })));
    await f.db.insert(storeProductAttrValue).values([
      { id: 11, productId: 101, type: 0, unique: 'base0001', suk: '红', stock: 60, price: '10.00', otPrice: '20.00', cost: '2.00' },
      { id: 12, productId: 101, type: 0, unique: 'base0002', suk: '蓝', stock: 40, price: '12.00', otPrice: '22.00', cost: '3.00' },
      { id: 13, productId: 102, type: 0, unique: 'base0003', suk: '默认', stock: 100, price: '10.00', otPrice: '20.00', cost: '2.00' },
    ]);
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),13,true)");
    await f.db.insert(storeProductAttr).values([{ productId: 101, type: 0, attrName: '颜色', attrValues: '红,蓝' }, { productId: 102, type: 0, attrName: '规格', attrValues: '默认' }]);
    await f.db.insert(storeProductDescription).values([{ productId: 101, type: 0, description: '<p>server source</p>' }, { productId: 102, type: 0, description: '<p>second source</p>' }]);
    await f.db.insert(systemRole).values([{ id: 1, roleName: '父活动读取', rules: 'seckill_activity.view' },
      { id: 2, roleName: '父活动管理', rules: 'seckill_activity.manage' }, { id: 3, roleName: '通用活动', rules: 'activity.manage' }]);
    await f.db.insert(systemAdmin).values([1, 2, 3].map(id => ({ id, account: `activity-admin-${id}`, pwd: 'fixture-password', level: 1, roles: String(id), adminType: 1 })));
    const signed = await Promise.all([1, 2, 3].map(async id => (await createToken(id, 'admin', md5('fixture-password'), env.APP_KEY)).token));
    const tokens = { reader: signed[0], manager: signed[1], other: signed[2] }, app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', container); await next(); });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    const auth = adminAuthMiddleware();
    for (const prefix of ['/adminapi', '/api/admin']) {
      const path = `${prefix}/activity/seckill-activities`;
      app.get(path, auth, Activity.list); app.get(`${path}/options`, auth, Activity.options);
      app.get(`${path}/products`, auth, Activity.products); app.get(`${path}/products/:productId`, auth, Activity.product);
      app.get(`${path}/:id`, auth, Activity.detail); app.post(path, auth, Activity.create); app.put(`${path}/:id`, auth, Activity.update);
      app.put(`${path}/:id/status`, auth, Activity.status); app.delete(`${path}/:id`, auth, Activity.remove);
    }
    const request = async (path = '', options: { method?: string; body?: unknown; token?: string; prefix?: string } = {}) => {
      const response = await app.request(`${options.prefix ?? '/adminapi'}/activity/seckill-activities${path}`, {
        method: options.method ?? 'GET', headers: { 'Authori-zation': `Bearer ${options.token ?? tokens.manager}`, ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }, env);
      return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
    };
    const revision = async (id: number) => (await request(`/${id}`)).body.data?.revision as string;
    const snapshot = async () => ({ parents: await f.db.select().from(storeActivity).orderBy(storeActivity.id),
      children: await f.db.select().from(storeSeckill).orderBy(storeSeckill.id), skus: await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id),
      sources: await f.db.select().from(storeProduct).orderBy(storeProduct.id), logs: await f.db.select().from(systemLog).orderBy(systemLog.id),
      retirements: await f.db.select().from(storeProductSkuRetirementLog).orderBy(storeProductSkuRetirementLog.id) });
    return { ...f, container, env, tokens, app, request, revision, snapshot, service: new AdminSeckillActivityService(container, env.APP_KEY),
      changeParent: async (id: number, values: Partial<typeof storeActivity.$inferInsert>) => f.db.update(storeActivity).set(values).where(eq(storeActivity.id, id)) };
  } catch (error) { await f.close(); throw error; }
}
export function seckillActivityInput(extra: Record<string, unknown> = {}) {
  const day = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
  return { request_id: crypto.randomUUID(), name: '多场秒杀', start_day: day, end_day: day, time_ids: [1, 2], num: 10, once_num: 2,
    image: '/api/assets/42', status: 1, products: [{ child_id: null, product_id: 101, status: 1,
      skus: [{ id: null, base_unique: 'base0001', price: '5.00', quota_total: 20, enabled: true },
        { id: null, base_unique: 'base0002', price: '6.00', quota_total: 10, enabled: true }] }], ...extra };
}
export function activityEdit(detail: any, extra: Record<string, unknown> = {}) {
  return { request_id: crypto.randomUUID(), revision: detail.revision, name: detail.name, start_day: detail.start_day, end_day: detail.end_day,
    time_ids: detail.time_ids, num: detail.num, once_num: detail.once_num, image: detail.image, status: detail.status,
    products: detail.products.map((product: any) => ({ child_id: product.child_id, product_id: product.product_id, status: product.deleted ? 0 : product.status,
      skus: product.skus.map((sku: any) => ({ id: sku.id, base_unique: sku.base_unique, price: sku.price, quota_total: sku.quota_total, enabled: sku.enabled })) })), ...extra };
}
