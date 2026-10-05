import { Hono } from 'hono';
import type { AppVariables, Env } from '../../src/env';
import { createContainerFromDb } from '../../src/lib/di';
import { legacyCategory, systemAdmin, systemLog, systemRole, storeIntegral, storeProductCategory } from '../../src/models/schema';
import * as Category from '../../src/controllers/api/v1/AdminIntegralCategoryController';
import { ActivityService } from '../../src/services/activity/ActivityService';
import { adminAuthMiddleware } from '../../src/middleware/admin-auth';
import { ApiException } from '../../src/utils/errors';
import { createToken, md5 } from '../../src/utils/jwt';
import { financePostgres } from './financePostgres';

export const categoryInput = { name: '新积分分类', integral_min: 201, integral_max: 300, sort: 2, is_show: 1 };
export async function integralCategoryFixture() {
  const f = await financePostgres([legacyCategory, systemAdmin, systemLog, systemRole, storeIntegral, storeProductCategory]);
  try {
    const container = createContainerFromDb(f.db);
    const env = { APP_KEY: 'integral-category-fixture-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
    await f.db.insert(legacyCategory).values([
      { id: 101, group: 5, name: '低积分', integralMin: 0, integralMax: 100, sort: 2, isShow: 1, addTime: 1_700_000_000 },
      { id: 102, group: 5, name: '隐藏积分', integralMin: 101, integralMax: 200, sort: 1, isShow: 0 },
      { id: 103, group: 1, name: '其他分类域', integralMin: 0, integralMax: 1000, sort: 100, isShow: 1 },
    ]);
    await f.exec("SELECT setval(pg_get_serial_sequence('category','id'),103,true)");
    await f.db.insert(storeIntegral).values({ id: 10, storeName: '积分商品不绑定分类ID', integral: 50 });
    await f.db.insert(storeProductCategory).values({ id: 20, cateName: '普通商品分类' });
    await f.db.insert(systemRole).values([
      { id: 1, roleName: '积分分类读取', rules: 'integral_category.view' },
      { id: 2, roleName: '积分分类管理', rules: 'integral_category.manage' },
      { id: 3, roleName: '普通商品分类管理', rules: 'category.manage' },
      { id: 4, roleName: '第二积分分类管理', rules: 'integral_category.manage' },
    ]);
    await f.db.insert(systemAdmin).values([1, 2, 3, 4].map(id => ({ id, account: `fixture-admin-${id}`, pwd: 'fixture-password',
      level: 1, roles: String(id), adminType: 1 })));
    const signed = await Promise.all([1, 2, 3, 4].map(async id => (await createToken(id, 'admin', md5('fixture-password'), env.APP_KEY)).token));
    const tokens = { reader: signed[0], manager: signed[1], other: signed[2], second: signed[3] };
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', container); await next(); });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    const auth = adminAuthMiddleware();
    for (const prefix of ['/adminapi', '/api/admin']) {
      const path = `${prefix}/marketing/integral-categories`;
      app.get(path, auth, Category.list); app.get(`${path}/:id`, auth, Category.detail);
      app.post(path, auth, Category.create); app.put(`${path}/:id`, auth, Category.update);
      app.put(`${path}/:id/status`, auth, Category.status); app.delete(`${path}/:id`, auth, Category.remove);
    }
    const request = async (path = '', options: { method?: string; body?: unknown; token?: string; prefix?: string } = {}) => {
      const response = await app.request(`${options.prefix ?? '/adminapi'}/marketing/integral-categories${path}`, {
        method: options.method ?? 'GET', headers: { 'Authori-zation': `Bearer ${options.token ?? tokens.manager}`,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }, env);
      return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
    };
    const revision = async (id = 101) => (await request(`/${id}`)).body.data?.revision as string;
    const snapshot = async () => ({ categories: await f.db.select().from(legacyCategory).orderBy(legacyCategory.id),
      logs: await f.db.select().from(systemLog).orderBy(systemLog.id),
      products: await f.db.select().from(storeIntegral), ordinary: await f.db.select().from(storeProductCategory) });
    return { ...f, container, env, tokens, app, request, revision, snapshot,
      publicCategories: () => new ActivityService(container, env).integralCategories() };
  } catch (error) { await f.close(); throw error; }
}
