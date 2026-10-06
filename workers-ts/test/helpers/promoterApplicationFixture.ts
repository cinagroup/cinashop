import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppVariables, Env } from '../../src/env';
import { createContainerFromDb } from '../../src/lib/di';
import { agreement, promoterApply, systemAdmin, systemLog, systemRole, user } from '../../src/models/schema';
import { adminList, adminExamine, adminDelete } from '../../src/controllers/api/v1/PromoterApplicationController';
import { adminAuthMiddleware } from '../../src/middleware/admin-auth';
import { ApiException } from '../../src/utils/errors';
import { createToken, md5 } from '../../src/utils/jwt';
import { financePostgres } from './financePostgres';

export async function promoterApplicationFixture() {
  const f = await financePostgres([agreement, promoterApply, systemAdmin, systemLog, systemRole, user]);
  try {
    const container = createContainerFromDb(f.db);
    const env = { APP_KEY: 'isolated-promoter-review-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
      CONFIG_KV: { get: async (key: string) => ['cfg_brokerage_func_status', 'cfg_store_brokerage_statu'].includes(key) ? '1' : null,
        put: async () => {}, delete: async () => {} },
    } as unknown as Env;
    await f.db.insert(agreement).values({ type: 2, status: 1, content: '本地测试推广协议' });
    await f.db.insert(user).values([
      { uid: 11, account: 'applicant', nickname: '当前用户昵称', phone: '13800138000' },
      { uid: 12, account: 'other-applicant', phone: '13800138001' },
    ]);
    await f.db.insert(promoterApply).values({ id: 101, uid: 11, nickname: '申请昵称', realName: '申请实名',
      phone: '13800138000', addTime: 1_700_000_000 });
    await f.exec("SELECT setval(pg_get_serial_sequence('promoter_apply','id'),101,true)");
    await f.db.insert(systemRole).values([
      { id: 1, roleName: '目录读取', rules: 'distribution.view' },
      { id: 2, roleName: '申请审核', rules: 'distribution.manage' },
      { id: 3, roleName: '无关角色', rules: 'product.view' },
    ]);
    await f.db.insert(systemAdmin).values([1, 2, 3].map(id => ({ id, account: `reviewer-${id}`,
      pwd: 'isolated-password', level: 1, roles: String(id), adminType: 1 })));
    const signed = await Promise.all([1, 2, 3].map(async id => (await createToken(id, 'admin', md5('isolated-password'), env.APP_KEY)).token));
    const tokens = { reader: signed[0], manager: signed[1], unrelated: signed[2] };
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', container); await next(); });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    const auth = adminAuthMiddleware();
    for (const prefix of ['/adminapi', '/api/admin']) {
      app.get(`${prefix}/promoter/apply/list`, auth, adminList);
      app.get(`${prefix}/promoter/apply/examine/:id/:uid/:status`, auth, adminExamine);
      app.post(`${prefix}/promoter/apply/examine/:id/:uid/:status`, auth, adminExamine);
      app.delete(`${prefix}/promoter/apply/del/:id`, auth, adminDelete);
    }
    const request = async (path: string, options: { method?: string; body?: unknown; token?: string; prefix?: string } = {}) => {
      const response = await app.request(`${options.prefix ?? '/adminapi'}/promoter/apply/${path}`, {
        method: options.method ?? 'GET', headers: { 'Authori-zation': `Bearer ${options.token ?? tokens.manager}`,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }, env);
      return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
    };
    const revision = async (id = 101) => {
      const result = await request('list?limit=100');
      return result.body.data.list.find((row: { id: number }) => row.id === id)?.revision as string;
    };
    const snapshot = async () => ({ applications: await f.db.select().from(promoterApply).orderBy(promoterApply.id),
      users: await f.db.select().from(user).orderBy(user.uid), logs: await f.db.select().from(systemLog).orderBy(systemLog.id) });
    const application = async () => (await f.db.select().from(promoterApply).where(eq(promoterApply.id, 101)))[0];
    return { ...f, container, env, app, tokens, request, revision, snapshot, application };
  } catch (error) { await f.close(); throw error; }
}
