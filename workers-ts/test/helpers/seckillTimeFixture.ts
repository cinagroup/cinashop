import { Hono } from 'hono';
import type { AppVariables, Env } from '../../src/env';
import { createContainerFromDb } from '../../src/lib/di';
import { storeActivity, storeSeckill, storeSeckillTime, systemAdmin, systemAttachment, systemConfig, systemLog, systemRole } from '../../src/models/schema';
import * as Time from '../../src/controllers/api/v1/AdminSeckillTimeController';
import { seckillIndex } from '../../src/controllers/api/v1/UserActivityController';
import { ActivityService } from '../../src/services/activity/ActivityService';
import { adminAuthMiddleware } from '../../src/middleware/admin-auth';
import { ApiException } from '../../src/utils/errors';
import { createToken, md5 } from '../../src/utils/jwt';
import { financePostgres } from './financePostgres';
import { seckillTimeReferenceLockFixture } from './seckillTimeReferenceLockFixture';

export const seckillTimeInput = { title: '下午场', start_time: '14:00', end_time: '16:00', pic: '/api/assets/42', describe: '限时秒杀', status: 1 };
export async function seckillTimeFixture() {
  const f = await seckillTimeReferenceLockFixture({ ...await financePostgres([storeActivity, storeSeckill, storeSeckillTime, systemAdmin, systemAttachment, systemConfig, systemLog, systemRole], { namespace: 'public' }),
    format: process.env.TEST_FINANCE_POSTGRES_URL ? 'pg16' : 'pglite' });
  try {
    const container = createContainerFromDb(f.db);
    const env = { APP_KEY: 'seckill-time-fixture-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
    await f.db.insert(systemAttachment).values([41, 42].map(attId => ({ attId, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, attDir: `/api/assets/${attId}` })));
    await f.db.insert(storeSeckillTime).values([
      { id: 101, title: '早场', startTime: '0900', endTime: '1100', pic: '/api/assets/41', describe: '早场秒杀', status: 1, addTime: 1_700_000_000 },
      { id: 102, title: '午场', startTime: '11:00', endTime: '13:00', pic: 'https://example.invalid/noon.png', describe: '午場秒杀', status: 0 },
    ]);
    await f.exec("SELECT setval(pg_get_serial_sequence('store_seckill_time','id'),102,true)");
    await f.db.insert(systemRole).values([
      { id: 1, roleName: '时段读取', rules: 'seckill_time.view' },
      { id: 2, roleName: '时段管理', rules: 'seckill_time.manage' },
      { id: 3, roleName: '通用活动', rules: 'activity.manage' },
      { id: 4, roleName: '第二管理员', rules: 'seckill_time.manage' },
    ]);
    await f.db.insert(systemAdmin).values([1, 2, 3, 4].map(id => ({ id, account: `fixture-admin-${id}`, pwd: 'fixture-password', level: 1, roles: String(id), adminType: 1 })));
    const signed = await Promise.all([1, 2, 3, 4].map(async id => (await createToken(id, 'admin', md5('fixture-password'), env.APP_KEY)).token));
    const tokens = { reader: signed[0], manager: signed[1], other: signed[2], second: signed[3] };
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', container); await next(); });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    app.get('/api/seckill/index', seckillIndex);
    const auth = adminAuthMiddleware();
    for (const prefix of ['/adminapi', '/api/admin']) {
      const path = `${prefix}/activity/seckill-times`;
      app.get(path, auth, Time.list); app.get(`${path}/:id`, auth, Time.detail);
      app.post(path, auth, Time.create); app.put(`${path}/:id`, auth, Time.update);
      app.put(`${path}/:id/status`, auth, Time.status); app.delete(`${path}/:id`, auth, Time.remove);
    }
    const request = async (path = '', options: { method?: string; body?: unknown; token?: string; prefix?: string } = {}) => {
      const response = await app.request(`${options.prefix ?? '/adminapi'}/activity/seckill-times${path}`, {
        method: options.method ?? 'GET', headers: { 'Authori-zation': `Bearer ${options.token ?? tokens.manager}`,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }, env);
      return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
    };
    const revision = async (id = 101) => (await request(`/${id}`)).body.data?.revision as string;
    const snapshot = async () => ({ slots: await f.db.select().from(storeSeckillTime).orderBy(storeSeckillTime.id),
      parents: await f.db.select().from(storeActivity).orderBy(storeActivity.id), children: await f.db.select().from(storeSeckill).orderBy(storeSeckill.id),
      logs: await f.db.select().from(systemLog).orderBy(systemLog.id) });
    return { ...f, container, env, tokens, app, request, revision, snapshot, public: new ActivityService(container, env) };
  } catch (error) { await f.close(); throw error; }
}
