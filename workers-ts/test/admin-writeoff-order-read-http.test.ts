import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { financePostgres } from './helpers/financePostgres';
import { storeOrder, storeOrderCartInfo, systemAdmin, systemRole,
  systemStore, systemStoreStaff, user } from '../src/models/schema';
import { createToken, md5 } from '../src/utils/jwt';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({
  ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => {
    if (!wiring.container) throw Error('Isolated writeoff fixture unavailable');
    return wiring.container;
  },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error('Isolated writeoff fixture unavailable');
    return { container: wiring.container, close: async () => {} };
  },
}));

let f: Awaited<ReturnType<typeof financePostgres>>;
const app = createApp();
const env = { APP_KEY: 'local-admin-writeoff-only', UPSTASH_REDIS_URL: '',
  UPSTASH_REDIS_TOKEN: '' } as Env;
const password = 'isolated-writeoff-role';
const identities = { reader: 9971, store: 9972, order: 9973, broad: 9974 } as const;
const tokens = new Map<keyof typeof identities, string>();

beforeEach(async () => {
  f = await financePostgres([systemAdmin, systemRole, user, storeOrder,
    storeOrderCartInfo, systemStore, systemStoreStaff]);
  wiring.container = createContainerFromDb(f.db);
  await f.db.insert(user).values([
    { uid: 11, nickname: 'Writeoff buyer', spreadUid: 20 },
    { uid: 20, nickname: 'Private promoter', cardId: 'TOP-SECRET-CARD',
      realName: 'Promoter real name', brokeragePrice: '2.00' },
  ]);
  await f.db.insert(systemStore).values({ id: 31, name: 'Open shop', isShow: 1, isDel: 0 });
  await f.db.insert(storeOrder).values({ id: 101, orderId: 'VERIFY-101', uid: 11,
    spreadUid: 20, storeId: 31, paid: 1, status: 2, shippingType: 2,
    refundStatus: 0, payPrice: '12.50' });
  await f.db.insert(storeOrderCartInfo).values({ id: 501, oid: 101, uid: 11,
    productId: 71, cartNum: 1, unique: 'cart-501', cartInfo: JSON.stringify({
      truePrice: '12.50', productInfo: { id: 71, store_name: 'Snapshot product',
        image: '/main.png', attrInfo: { suk: 'XL', image: '/sku.png' } },
    }) });
  const rules: Record<keyof typeof identities, string> = {
    reader: 'writeoff_order.view', store: 'store.view', order: 'order.view',
    broad: 'store.manage,order.manage,user.view',
  };
  await f.db.insert(systemRole).values(Object.entries(identities).map(([name, id]) => ({
    id, roleName: `Writeoff ${name}`, rules: rules[name as keyof typeof identities],
  })));
  await f.db.insert(systemAdmin).values(Object.entries(identities).map(([name, id]) => ({
    id, account: `writeoff-${name}`, pwd: password, roles: String(id), level: 1,
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
  const response = await app.request(`${base}/merchant/${path}`, {
    method, headers: name === 'anonymous' ? {} : { Authorization: `Bearer ${tokens.get(name)}` },
  }, env);
  return { status: response.status, cache: response.headers.get('Cache-Control'),
    body: await response.json<{ status: number; msg: string; data: Record<string, unknown> | null }>() };
}

it.each(['/adminapi', '/api/admin'])('requires writeoff_order.view on all four GETs at %s', async base => {
  for (const path of ['verify_order', 'verify_order/stores',
    'verify/spread_info/11', 'verify_badge']) {
    expect((await request(base, 'anonymous', path)).body.status).not.toBe(200);
    for (const name of ['store', 'order', 'broad'] as const) {
      expect((await request(base, name, path)).body.status).not.toBe(200);
    }
  }
  const list = await request(base, 'reader', 'verify_order');
  expect(list.body).toMatchObject({ status: 200, data: { count: 1, page: 1,
    limit: 15, badge: [], list: [{ id: 101, order_id: 'VERIFY-101',
      goods: [{ name: 'Snapshot product', spec: 'XL', image: '/sku.png' }] }] } });
  expect(list.cache).toContain('no-store');
  expect((await request(base, 'reader', 'verify_order/stores')).body)
    .toMatchObject({ status: 200, data: { list: [{ id: 31, name: 'Open shop' }] } });
  const spread = await request(base, 'reader', 'verify/spread_info/11');
  expect(spread.body).toMatchObject({ status: 200, data: { spread: {
    uid: 20, nickname: 'Private promoter', brokerage_price: '2.00' } } });
  expect(JSON.stringify(spread)).not.toContain('TOP-SECRET-CARD');
  expect((await request(base, 'reader', 'verify_badge')).body)
    .toMatchObject({ status: 200, data: [] });
  expect((await request(base, 'reader', 'verify/spread_info/20')).body.status).not.toBe(200);
  expect((await request(base, 'reader', 'verify_order?unknown=1')).body.status).not.toBe(200);
  expect((await request(base, 'reader', 'verify_order/stores?extra=1')).body.status).not.toBe(200);
  expect((await request(base, 'reader', 'verify_order', 'DELETE')).body.status).not.toBe(200);
});
