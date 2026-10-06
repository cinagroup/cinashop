import { Hono } from 'hono';
import type { AppVariables, Env } from '../../src/env';
import { createContainerFromDb } from '../../src/lib/di';
import { systemGroup, systemGroupData, systemAdmin, systemLog, systemRole, user, userRecharge, userBill } from '../../src/models/schema';
import * as Quota from '../../src/controllers/api/v1/AdminRechargeQuotaController';
import { UserFinanceService } from '../../src/services/user/UserFinanceService';
import { adminAuthMiddleware } from '../../src/middleware/admin-auth';
import { ApiException } from '../../src/utils/errors';
import { createToken, md5 } from '../../src/utils/jwt';
import { financePostgres } from './financePostgres';

export const quotaInput = { price: '100.00', give_money: '10.00', sort: 1, status: 1 };
export const quotaValue = (price = '100.00', gift = '10.00') => JSON.stringify({ price: { type: 'input', value: price }, give_money: { type: 'input', value: gift } });
export async function rechargeQuotaFixture() {
  const f = await financePostgres([systemGroup, systemGroupData, systemAdmin, systemLog, systemRole, user, userRecharge, userBill]);
  try {
    const container = createContainerFromDb(f.db);
    const env = { APP_KEY: 'recharge-quota-fixture-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
    await f.db.insert(systemGroup).values([{ id: 77, configName: 'user_recharge_quota', name: '充值档位' }, { id: 62, configName: 'other_data' }]);
    await f.db.insert(systemGroupData).values([
      { id: 101, gid: 77, value: quotaValue(), sort: 2, status: 1, addTime: 1_700_000_000 },
      { id: 102, gid: 77, value: quotaValue('200.00', '30.00'), sort: 2, status: 0 },
      { id: 103, gid: 62, value: quotaValue('999.00'), sort: 100, status: 1 },
    ]);
    await f.exec("SELECT setval(pg_get_serial_sequence('system_group_data','id'),103,true)");
    await f.db.insert(user).values({ uid: 10, account: 'quota-fixture-user', nowMoney: '5.00', status: 1, isDel: 0 });
    await f.db.insert(systemRole).values([
      { id: 1, roleName: '档位读取', rules: 'recharge_quota.view' },
      { id: 2, roleName: '档位管理', rules: 'recharge_quota.manage' },
      { id: 3, roleName: '通用配置管理', rules: 'config.manage' },
      { id: 4, roleName: '第二档位管理', rules: 'recharge_quota.manage' },
    ]);
    await f.db.insert(systemAdmin).values([1, 2, 3, 4].map(id => ({ id, account: `fixture-admin-${id}`, pwd: 'fixture-password', level: 1, roles: String(id), adminType: 1 })));
    const signed = await Promise.all([1, 2, 3, 4].map(async id => (await createToken(id, 'admin', md5('fixture-password'), env.APP_KEY)).token));
    const tokens = { reader: signed[0], manager: signed[1], other: signed[2], second: signed[3] };
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', container); await next(); });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    const auth = adminAuthMiddleware();
    for (const prefix of ['/adminapi', '/api/admin']) {
      const path = `${prefix}/marketing/recharge-quotas`;
      app.get(path, auth, Quota.list); app.get(`${path}/:id`, auth, Quota.detail);
      app.post(path, auth, Quota.create); app.put(`${path}/:id`, auth, Quota.update);
      app.put(`${path}/:id/status`, auth, Quota.status); app.delete(`${path}/:id`, auth, Quota.remove);
    }
    const request = async (path = '', options: { method?: string; body?: unknown; token?: string; prefix?: string } = {}) => {
      const response = await app.request(`${options.prefix ?? '/adminapi'}/marketing/recharge-quotas${path}`, {
        method: options.method ?? 'GET', headers: { 'Authori-zation': `Bearer ${options.token ?? tokens.manager}`,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }, env);
      return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
    };
    const revision = async (id = 101) => (await request(`/${id}`)).body.data?.revision as string;
    const snapshot = async () => ({ groups: await f.db.select().from(systemGroup).orderBy(systemGroup.id),
      quotas: await f.db.select().from(systemGroupData).orderBy(systemGroupData.id), logs: await f.db.select().from(systemLog).orderBy(systemLog.id),
      orders: await f.db.select().from(userRecharge).orderBy(userRecharge.id), users: await f.db.select().from(user), bills: await f.db.select().from(userBill) });
    return { ...f, container, env, tokens, app, request, revision, snapshot,
      finance: new UserFinanceService(container), publicQuotas: async () => (await new UserFinanceService(container).rechargeIndex()).recharge_quota };
  } catch (error) { await f.close(); throw error; }
}
