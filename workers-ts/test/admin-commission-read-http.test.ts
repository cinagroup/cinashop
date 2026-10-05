import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { financePostgres } from './helpers/financePostgres';
import { systemAdmin, systemRole, user, userBrokerage, userExtract } from '../src/models/schema';
import { createToken, md5 } from '../src/utils/jwt';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({
  ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => {
    if (!wiring.container) throw Error('Isolated commission fixture unavailable');
    return wiring.container;
  },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error('Isolated commission fixture unavailable');
    return { container: wiring.container, close: async () => {} };
  },
}));

let f: Awaited<ReturnType<typeof financePostgres>>;
const app = createApp();
const env = { APP_KEY: 'local-admin-commission-only', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const password = 'isolated-commission-role';
const identities = { reader: 9961, distribution: 9962, bill: 9963, broad: 9964 } as const;
const tokens = new Map<keyof typeof identities, string>();

beforeEach(async () => {
  f = await financePostgres([systemAdmin, systemRole, user, userBrokerage, userExtract]);
  wiring.container = createContainerFromDb(f.db);
  await f.db.insert(user).values({ uid: 11, nickname: 'Commission holder', phone: '13800000011',
    brokeragePrice: '10.00', nowMoney: '3.00' });
  await f.db.insert(userBrokerage).values({ id: 71, uid: 11, type: 'one_brokerage',
    number: '7.00', pm: 1, status: 1, mark: 'Private commission note', addTime: 1_700_000_000 });
  await f.db.insert(userExtract).values({ id: 81, uid: 11, status: 0,
    extractPrice: '2.00', extractFee: '0.50' });
  const rules: Record<keyof typeof identities, string> = {
    reader: 'commission.view', distribution: 'distribution.view',
    bill: 'bill.view', broad: 'user.manage,order.manage,refund.manage',
  };
  await f.db.insert(systemRole).values(Object.entries(identities).map(([name, id]) => ({
    id, roleName: `Commission ${name}`, rules: rules[name as keyof typeof identities],
  })));
  await f.db.insert(systemAdmin).values(Object.entries(identities).map(([name, id]) => ({
    id, account: `commission-${name}`, pwd: password, roles: String(id), level: 1,
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
  const response = await app.request(`${base}/finance/commissions${path}`, {
    method, headers: name === 'anonymous' ? {} : { Authorization: `Bearer ${tokens.get(name)}` },
  }, env);
  return { status: response.status, cache: response.headers.get('Cache-Control'),
    body: await response.json<{ status: number; msg: string; data: Record<string, unknown> | null }>() };
}

it.each(['/adminapi', '/api/admin'])('enforces commission.view and white-listed reads at %s', async base => {
  expect((await request(base, 'anonymous', '')).body.status).not.toBe(200);
  for (const name of ['distribution', 'bill', 'broad'] as const) {
    for (const path of ['', '/11', '/11/records']) {
      const denied = await request(base, name, path);
      expect(denied.body.status).not.toBe(200);
      expect(JSON.stringify(denied)).not.toContain('Private commission note');
    }
  }
  const list = await request(base, 'reader', '?price_min=10&price_max=10');
  expect(list.body).toMatchObject({ status: 200, data: { count: 1,
    list: [{ uid: 11, nickname: 'Commission holder',
      extract_price: '2.50', sum_number: '12.50' }] } });
  expect(list.cache).toContain('no-store');
  expect(JSON.stringify(list)).not.toContain('Private commission note');
  expect((await request(base, 'reader', '/11')).body).toMatchObject({ status: 200,
    data: { uid: 11, number: '7.00', now_money: '3.00', spread_name: '' } });
  expect((await request(base, 'reader', '/11/records')).body).toMatchObject({ status: 200,
    data: { count: 1, list: [{ id: 71, number: '7.00', mark: 'Private commission note' }] } });
  expect((await request(base, 'reader', '?price_min=-1')).body.status).not.toBe(200);
  expect((await request(base, 'reader', '/11?extra=1')).body.status).not.toBe(200);
  expect((await request(base, 'reader', '/11/records?limit=101')).body.status).not.toBe(200);
  expect((await request(base, 'reader', '/11/records', 'DELETE')).body.status).not.toBe(200);
});
