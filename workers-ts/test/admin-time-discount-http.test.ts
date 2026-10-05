import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { createContainerFromDb, type Container } from '../src/lib/di';
import {
  storeBrand, storeOrder, storeOrderCartInfo, storeOrderPromotions, storeProduct,
  storeProductAttrValue, storeProductCategory, storeProductLabel, storeProductRelation,
  storePromotions, storePromotionsAuxiliary, systemAdmin, systemLog, systemMenus,
  systemRole, userLabel,
} from '../src/models/schema';
import { createToken, md5 } from '../src/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({
  ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Time discount HTTP fixture unavailable'); return wiring.container; },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error('Time discount HTTP fixture unavailable');
    return { container: wiring.container, close: async () => {} };
  },
}));

const app = createApp();
const env = { APP_KEY: 'local-time-discount-http-only', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const password = 'time-discount-http-fixture';
const identities = { reader: 9741, manager: 9742, adjacent: 9743 } as const;
type Identity = keyof typeof identities;
const tokens = new Map<Identity, string>();
let fixture: Awaited<ReturnType<typeof financePostgres>>;
const date = (hours: number) => new Date(Date.now() + (hours + 8) * 3_600_000)
  .toISOString().replace('T', ' ').slice(0, 19);
const body = () => ({ name: 'HTTP限时折扣', section_time: [date(-1), date(48)],
  discount: 90, is_limit: 1, limit_num: 2, label_id: [31], overlay: [2, 5],
  product_partake_type: 2, product_id: [{ product_id: 1, unique: ['abc11111'] }],
  brand_id: [], store_label_id: [], status: 1, sort: 0, request_id: crypto.randomUUID() });

beforeEach(async () => {
  fixture = await financePostgres([
    storePromotions, storePromotionsAuxiliary, storeProduct, storeProductAttrValue,
    storeProductRelation, storeProductCategory, storeBrand, storeProductLabel, userLabel,
    storeOrder, storeOrderCartInfo, storeOrderPromotions,
    systemLog, systemMenus, systemRole, systemAdmin,
  ]);
  wiring.container = createContainerFromDb(fixture.db);
  await fixture.db.insert(storeProduct).values({ id: 1, storeName: '父商品',
    pid: 0, isShow: 1, isDel: 0, isVerify: 1 });
  await fixture.db.insert(storeProductAttrValue).values([
    { id: 1, productId: 1, type: 0, unique: 'abc11111', suk: '红色' },
    { id: 2, productId: 1, type: 0, unique: 'abc22222', suk: '粉色' },
  ]);
  await fixture.db.insert(storeBrand).values({ id: 11, brandName: '花园', isShow: 1, isDel: 0 });
  await fixture.db.insert(storeProductLabel).values({ id: 21, labelName: '热销',
    type: 0, relationId: 0, status: 1, isShow: 1 });
  await fixture.db.insert(userLabel).values({ id: 31, name: '新客', type: 0, relationId: 0, status: 1 });
  await fixture.db.insert(storePromotions).values({ id: 101, promotionsType: 2,
    type: 1, storeId: 0, pid: 0, name: '相邻促销隔离' });
  await fixture.db.insert(systemMenus).values([
    { id: 1394, type: 1, authType: 1, access: 1,
      menuPath: '/admin/marketing/discount/list', uniqueAuth: 'marketing-discount-list' },
    { id: 1398, type: 1, authType: 1, access: 1,
      menuPath: '/admin/marketing/discount/add', uniqueAuth: 'marketing-discount-add' },
  ]);
  const rules: Record<Identity, string> = {
    reader: '1394', manager: '1398', adjacent: 'activity.manage',
  };
  await fixture.db.insert(systemRole).values(Object.entries(identities).map(([name, id]) => ({
    id, roleName: name, rules: rules[name as Identity],
  })));
  await fixture.db.insert(systemAdmin).values(Object.entries(identities).map(([name, id]) => ({
    id, account: `discount-${name}`, pwd: password, roles: String(id),
    level: 1, adminType: 1, status: 1, isDel: 0,
  })));
  for (const [name, id] of Object.entries(identities)) tokens.set(name as Identity,
    (await createToken(id, 'admin', md5(password), env.APP_KEY)).token);
}, 30_000);
afterEach(async () => { wiring.container = undefined; tokens.clear(); await fixture?.close(); });

async function request(base: string, identity: Identity | 'anonymous', suffix = '',
  method = 'GET', data?: Record<string, unknown>) {
  const response = await app.request(`${base}/marketing/time-discounts${suffix}`, {
    method,
    headers: { ...(identity === 'anonymous' ? {} : { Authorization: `Bearer ${tokens.get(identity)}` }),
      ...(data ? { 'Content-Type': 'application/json' } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  }, env);
  return { cache: response.headers.get('Cache-Control'),
    body: await response.json<{ status: number; msg: string; data: any }>() };
}

it.each(['/adminapi', '/api/admin'])('guards and serves all ten real time-discount routes on %s', async base => {
  for (const identity of ['anonymous', 'adjacent'] as const) {
    const denied = identity === 'anonymous' ? 410000 : 400011;
    expect((await request(base, identity)).body.status).toBe(denied);
    expect((await request(base, identity, '', 'POST', body())).body.status).toBe(denied);
  }
  expect((await request(base, 'reader')).body).toMatchObject({ status: 200,
    data: { count: 0, list: [], page: 1, limit: 15 } });
  expect((await request(base, 'reader', '', 'POST', body())).body.status).toBe(400011);
  for (const suffix of ['/products', '/brands', '/labels', '/user-labels']) {
    const choice = await request(base, 'reader', suffix);
    expect(choice.body).toMatchObject({ status: 200, data: { count: 1, page: 1, list: [expect.any(Object)] } });
    expect(choice.cache).toContain('no-store');
  }
  expect((await request(base, 'reader', '/products')).body.data.list[0].attrValue)
    .toEqual(expect.arrayContaining([expect.objectContaining({ unique: 'abc11111' }),
      expect.objectContaining({ unique: 'abc22222' })]));
  expect((await request(base, 'reader', '/user-labels')).body.data.list[0])
    .toMatchObject({ id: 31, label_name: '新客' });
  const input = body();
  const created = await request(base, 'manager', '', 'POST', input);
  expect(created.body).toMatchObject({ status: 200, data: { id: expect.any(Number) } });
  expect(created.cache).toContain('no-store');
  const id = created.body.data.id;
  expect((await request(base, 'manager', '', 'POST', input)).body.data.id).toBe(id);
  expect((await request(base, 'manager', '/101')).body.status).toBe(404);
  let detail = await request(base, 'reader', `/${id}`);
  expect(detail.body).toMatchObject({ status: 200, data: { info: {
    id, promotionsType: 1, product_id: [{ product_id: 1, unique: ['abc11111'] }],
    products: [{ id: 1, attrValue: [{ unique: 'abc11111' }] }],
    label_id: [31], user_labels: [{ id: 31, label_name: '新客' }],
    product_count: 1, sum_order: 0,
  } } });
  expect(detail.cache).toContain('no-store');
  expect((await request(base, 'reader', `/${id}/status`, 'PATCH',
    { status: 0, revision: detail.body.data.info.revision, request_id: crypto.randomUUID() })).body.status)
    .toBe(400011);
  const staleRevision = detail.body.data.info.revision;
  expect((await request(base, 'manager', `/${id}`, 'PUT',
    { ...body(), name: 'HTTP限时折扣更新', revision: staleRevision })).body.status).toBe(200);
  expect((await request(base, 'manager', `/${id}`, 'PUT',
    { ...body(), revision: staleRevision })).body.status).toBe(409);
  detail = await request(base, 'manager', `/${id}`);
  expect((await request(base, 'manager', `/${id}/status`, 'PATCH',
    { status: 0, revision: detail.body.data.info.revision, request_id: crypto.randomUUID() })).body.status)
    .toBe(200);
  detail = await request(base, 'manager', `/${id}`);
  expect((await request(base, 'manager', `/${id}`, 'DELETE',
    { revision: detail.body.data.info.revision, request_id: crypto.randomUUID() })).body.status).toBe(200);
  expect((await request(base, 'reader', `/${id}`)).body.status).toBe(404);
}, 30_000);
