import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { financePostgres } from './helpers/financePostgres';
import { systemAdmin, systemRole, user, userRecharge } from '../src/models/schema';
import { createToken, md5 } from '../src/utils/jwt';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({
  ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => {
    if (!wiring.container) throw Error('Isolated recharge-order fixture unavailable');
    return wiring.container;
  },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error('Isolated recharge-order fixture unavailable');
    return { container: wiring.container, close: async () => {} };
  },
}));

let f: Awaited<ReturnType<typeof financePostgres>>;
const app = createApp();
const env = { APP_KEY: 'local-admin-recharge-order', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const password = 'isolated-recharge-order-role';
const identities = { reader: 9911, bill: 9912, quota: 9913, broad: 9914 } as const;
const tokens = new Map<keyof typeof identities, string>();

beforeEach(async () => {
  f = await financePostgres([systemAdmin, systemRole, user, userRecharge]);
  wiring.container = createContainerFromDb(f.db);
  await f.db.insert(user).values({ uid: 41, nickname: 'Recharge buyer', phone: '13800000041' });
  await f.db.insert(userRecharge).values([
    { id: 51, uid: 41, orderId: 'czADMINPAID51', price: '12.00',
      paid: 1, rechargeType: 'routine', payTime: 1_700_000_010, addTime: 1_700_000_000,
      tradeNo: 'private-recharge-trade' },
    { id: 52, uid: 999, orderId: 'czADMINWAIT52', price: '8.00',
      paid: 0, rechargeType: 'weixin', addTime: 1_700_000_020 },
  ]);
  const rules: Record<keyof typeof identities, string> = {
    reader: 'recharge_order.view', bill: 'bill.view',
    quota: 'recharge_quota.view', broad: 'order.manage,refund.manage,user.manage',
  };
  await f.db.insert(systemRole).values(Object.entries(identities).map(([name, id]) => ({
    id, roleName: `Recharge ${name}`, rules: rules[name as keyof typeof identities],
  })));
  await f.db.insert(systemAdmin).values(Object.entries(identities).map(([name, id]) => ({
    id, account: `recharge-${name}`, pwd: password, roles: String(id), level: 1,
    adminType: 1, status: 1, isDel: 0,
  })));
  for (const [name, id] of Object.entries(identities)) {
    tokens.set(name as keyof typeof identities,
      (await createToken(id, 'admin', md5(password), env.APP_KEY)).token);
  }
}, 30_000);
afterEach(async () => { wiring.container = undefined; tokens.clear(); await f?.close(); });

async function request(base: string, name: keyof typeof identities | 'anonymous', path: string,
  method = 'GET') {
  const response = await app.request(`${base}/finance/recharge-orders${path}`, {
    method, headers: name === 'anonymous' ? {} : { Authorization: `Bearer ${tokens.get(name)}` },
  }, env);
  return { status: response.status, cache: response.headers.get('Cache-Control'),
    body: await response.json<{ status: number; msg: string; data: Record<string, unknown> | null }>() };
}

it.each(['/adminapi', '/api/admin'])('serves the exact read-only recharge contract under %s', async base => {
  const anonymous = await request(base, 'anonymous', '');
  expect(anonymous.body.status).not.toBe(200);
  for (const name of ['bill', 'quota', 'broad'] as const) {
    for (const path of ['', '/stats', '/51']) {
      const denied = await request(base, name, path);
      expect(denied.body.status).not.toBe(200);
      expect(JSON.stringify(denied)).not.toContain('private-recharge-trade');
    }
  }
  const list = await request(base, 'reader', '?paid=0');
  expect(list.body).toMatchObject({ status: 200, data: { count: 1,
    list: [{ id: 52, paid: 0, user_missing: true, nickname: '', avatar: '' }] } });
  expect(list.cache).toContain('no-store');
  expect(JSON.stringify(list)).not.toContain('private-recharge-trade');
  const detail = await request(base, 'reader', '/51');
  expect(detail.body).toMatchObject({ status: 200, data: {
    id: 51, order_id: 'czADMINPAID51', nickname: 'Recharge buyer',
    phone: '13800000041', real_name: '', trade_no: 'private-recharge-trade',
    channel_type: '', remarks: '', paid: 1, user_deleted: false,
  } });
  const stats = await request(base, 'reader', '/stats?paid=0');
  expect(stats.body).toMatchObject({ status: 200, data: {
    sum_price: '12.00', sum_refund_price: '0.00',
    sum_routine_price: '12.00', sum_weixin_price: '0.00',
  } });
  expect((await request(base, 'reader', '?limit=101')).body.status).not.toBe(200);
  expect((await request(base, 'reader', '?keyword=x&keyword=y')).body.status).not.toBe(200);
  expect((await request(base, 'reader', '/51?extra=1')).body.status).not.toBe(200);
  expect((await request(base, 'reader', '/51', 'DELETE')).body.status).not.toBe(200);
});
