import { Hono } from 'hono';
import { expect, it } from 'vitest';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { systemAdmin, systemGroup, systemGroupData, systemLog, systemRole, user, userBill, userRecharge } from '../src/models/schema';
import { RECHARGE_QUOTA_GROUP_SEED_SQL } from '../src/migrations/rechargeQuotaGroupSeed';
import { runRechargeQuotaGroupSeed } from '../src/migrations/runRechargeQuotaGroupSeed';
import * as Quota from '../src/controllers/api/v1/AdminRechargeQuotaController';
import { adminAuthMiddleware } from '../src/middleware/admin-auth';
import { UserFinanceService } from '../src/services/user/UserFinanceService';
import { ApiException } from '../src/utils/errors';
import { createToken, md5 } from '../src/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

it('connects an empty recharge configuration through the formal seed, Admin creation, storefront reads and immutable order snapshots', async () => {
  // Tables model a newly built domain. No recharge group or option is inserted
  // by the fixture; only the formal migration may create the fixed empty group.
  const f = await financePostgres([systemGroup, systemGroupData, systemAdmin, systemRole, systemLog, user, userRecharge, userBill], { namespace: 'public' });
  try {
    await f.exec('CREATE UNIQUE INDEX system_group_config_name_uq ON public.system_group(config_name)');
    const container = createContainerFromDb(f.db);
    const finance = new UserFinanceService(container);
    const env = { APP_KEY: 'recharge-seed-flow-fixture-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
    await f.db.insert(systemRole).values({ id: 1, roleName: '档位管理', rules: 'recharge_quota.manage' });
    await f.db.insert(systemAdmin).values({ id: 1, account: 'seed-flow-admin', pwd: 'fixture-password', level: 1, roles: '1', adminType: 1 });
    await f.db.insert(user).values({ uid: 10, account: 'seed-flow-buyer', nowMoney: '5.00', status: 1, isDel: 0 });
    const token = (await createToken(1, 'admin', md5('fixture-password'), env.APP_KEY)).token;
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', container); await next(); });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    const auth = adminAuthMiddleware();
    for (const prefix of ['/adminapi', '/api/admin']) {
      const path = `${prefix}/marketing/recharge-quotas`;
      app.get(path, auth, Quota.list); app.get(`${path}/:id`, auth, Quota.detail);
      app.post(path, auth, Quota.create); app.put(`${path}/:id`, auth, Quota.update);
    }
    const request = async (path = '', method = 'GET', body?: unknown, prefix = '/adminapi') => {
      const response = await app.request(`${prefix}/marketing/recharge-quotas${path}`, {
        method, headers: { 'Authori-zation': `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, env);
      return response.json<{ status: number; msg: string; data: any }>();
    };
    const applySeed = async () => {
      if (process.env.TEST_FINANCE_POSTGRES_URL) await runRechargeQuotaGroupSeed(f.db);
      else {
        try { await f.exec(`BEGIN; ${RECHARGE_QUOTA_GROUP_SEED_SQL} COMMIT;`); }
        catch (error) { await f.exec('ROLLBACK'); throw error; }
      }
    };
    const snapshot = async () => ({
      groups: await f.db.select().from(systemGroup).orderBy(systemGroup.id),
      quotas: await f.db.select().from(systemGroupData).orderBy(systemGroupData.id),
      logs: await f.db.select().from(systemLog).orderBy(systemLog.id),
      orders: await f.db.select().from(userRecharge).orderBy(userRecharge.id),
      users: await f.db.select().from(user).orderBy(user.uid),
      bills: await f.db.select().from(userBill).orderBy(userBill.id),
    });
    const before = await snapshot();
    expect(before.groups).toEqual([]); expect(before.quotas).toEqual([]); expect(before.orders).toEqual([]);
    expect(await request('?page=1&limit=100')).toMatchObject({ status: 400, msg: '充值档位配置组不存在，请先完成基础配置' });
    expect((await finance.rechargeIndex()).recharge_quota).toEqual([]);

    await applySeed();
    const seeded = await snapshot();
    expect(seeded.groups).toHaveLength(1);
    expect(seeded.groups[0]).toMatchObject({ configName: 'user_recharge_quota' });
    expect(seeded.groups[0].id).toBeGreaterThan(0);
    expect(seeded.quotas).toEqual([]); expect(seeded.orders).toEqual(before.orders);
    expect(seeded.users).toEqual(before.users); expect(seeded.bills).toEqual(before.bills);
    expect(seeded.logs).toHaveLength(1);
    expect(seeded.logs[0]).toMatchObject({ adminId: 0, type: 'recharge_quota_seed', path: '/migration/0166/recharge-quota-group' });
    for (const prefix of ['/adminapi', '/api/admin']) {
      expect(await request('?page=1&limit=100', 'GET', undefined, prefix)).toMatchObject({ status: 200, data: { list: [], count: 0, page: 1, limit: 100 } });
    }
    expect((await finance.rechargeIndex()).recharge_quota).toEqual([]);

    const input = { price: '88.80', give_money: '12.34', sort: 1, status: 1, request_id: crypto.randomUUID() };
    const created = await request('', 'POST', input);
    expect(created.status).toBe(200); expect(created.data.id).toBeGreaterThan(0);
    expect(await request('', 'POST', input)).toEqual(created);
    const listed = await request('?page=1&limit=100');
    expect(listed.data.count).toBe(1); expect(listed.data.list).toHaveLength(1);
    expect(listed.data.list[0]).toMatchObject({ id: created.data.id, price: '88.80', give_money: '12.34', status: 1, valid: true });
    expect(listed.data.list[0].revision).toMatch(/^[a-f0-9]{64}$/u);
    expect((await finance.rechargeIndex()).recharge_quota).toEqual([{ id: created.data.id, price: '88.80', give_money: '12.34' }]);

    const order = await finance.recharge(10, 0.01, 'h5', created.data.id);
    expect(order.price).toBe('88.80');
    const purchased = await snapshot();
    expect(purchased.orders).toHaveLength(1);
    expect(purchased.orders[0]).toMatchObject({ uid: 10, orderId: order.orderId, price: '88.80', givePrice: '12.34', paid: 0 });
    expect(purchased.users).toEqual(before.users); expect(purchased.bills).toEqual([]);

    const updated = await request(`/${created.data.id}`, 'PUT', { ...input, price: '100.00', give_money: '20.00', revision: listed.data.list[0].revision, request_id: crypto.randomUUID() });
    expect(updated.status).toBe(200);
    expect((await finance.rechargeIndex()).recharge_quota).toEqual([{ id: created.data.id, price: '100.00', give_money: '20.00' }]);
    const maintained = await snapshot();
    expect(maintained.orders).toEqual(purchased.orders); expect(maintained.users).toEqual(before.users); expect(maintained.bills).toEqual([]);
    expect(maintained.logs.filter(log => log.type === 'recharge_quota')).toHaveLength(2);
    await applySeed();
    expect(await snapshot()).toEqual(maintained);
  } finally { await f.close(); }
}, 30_000);
