import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { createContainerFromDb, type Container } from '../src/lib/di';
import { storeBrand, storeProduct, storeProductCategory, storeProductLabel, storeProductRelation,
  storePromotions, storePromotionsAuxiliary, systemAdmin, systemLog, systemMenus, systemRole } from '../src/models/schema';
import { createToken, md5 } from '../src/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({
  ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Background HTTP fixture unavailable'); return wiring.container; },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error('Background HTTP fixture unavailable');
    return { container: wiring.container, close: async () => {} };
  },
}));

const app = createApp();
const env = { APP_KEY: 'local-background-http-only', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const password = 'background-http-fixture';
const identities = { reader: 9711, manager: 9712, frame: 9713, generic: 9714 } as const;
type Identity = keyof typeof identities;
const tokens = new Map<Identity, string>();
let fixture: Awaited<ReturnType<typeof financePostgres>>;
const date = (hours: number) => new Date(Date.now() + (hours + 8) * 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
const body = () => ({ name: 'HTTP背景', image: '/uploads/background.png', product_partake_type: 2,
  product_id: [1], brand_id: [], store_label_id: [], section_time: [date(-1), date(48)],
  status: 1, sort: 0, request_id: crypto.randomUUID() });

beforeEach(async () => {
  fixture = await financePostgres([storePromotions, storePromotionsAuxiliary, storeProduct,
    storeProductRelation, storeProductCategory, storeBrand, storeProductLabel, systemLog, systemMenus, systemRole, systemAdmin]);
  wiring.container = createContainerFromDb(fixture.db);
  await fixture.db.insert(storeProduct).values({ id: 1, storeName: '父商品', isShow: 1, isDel: 0, isVerify: 1 });
  await fixture.db.insert(storePromotions).values({ id: 101, promotionsType: 5, type: 1, storeId: 0, pid: 0, name: '边框隔离' });
  await fixture.db.insert(systemMenus).values([
    { id: 1542, type: 1, authType: 1, access: 1, menuPath: '/admin/marketing/activity_background', uniqueAuth: 'admin-marketing-activity_background' },
    { id: 1546, type: 1, authType: 1, access: 1, menuPath: '/admin/marketing/activity_background/create', uniqueAuth: 'marketing-activity_background-create' },
  ]);
  const rules: Record<Identity, string> = { reader: '1542', manager: '1546', frame: 'activity_frame.manage', generic: 'activity.manage' };
  await fixture.db.insert(systemRole).values(Object.entries(identities).map(([name, id]) => ({ id, roleName: name, rules: rules[name as Identity] })));
  await fixture.db.insert(systemAdmin).values(Object.entries(identities).map(([name, id]) => ({
    id, account: `background-${name}`, pwd: password, roles: String(id), level: 1, adminType: 1, status: 1, isDel: 0,
  })));
  for (const [name, id] of Object.entries(identities)) tokens.set(name as Identity, (await createToken(id, 'admin', md5(password), env.APP_KEY)).token);
}, 30_000);
afterEach(async () => { wiring.container = undefined; tokens.clear(); await fixture?.close(); });

async function request(base: string, identity: Identity | 'anonymous', suffix = '', method = 'GET', data?: Record<string, unknown>) {
  const response = await app.request(`${base}/marketing/activity-background${suffix}`, {
    method, headers: { ...(identity === 'anonymous' ? {} : { Authorization: `Bearer ${tokens.get(identity)}` }),
      ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}),
  }, env);
  return { cache: response.headers.get('Cache-Control'), body: await response.json<{ status: number; msg: string; data: any }>() };
}

it.each(['/adminapi', '/api/admin'])('enforces real registered background reads and writes on %s', async base => {
  for (const identity of ['anonymous', 'frame', 'generic'] as const) {
    const deniedCode = identity === 'anonymous' ? 410000 : 400011;
    expect((await request(base, identity)).body.status).toBe(deniedCode);
    expect((await request(base, identity, '', 'POST', body())).body.status).toBe(deniedCode);
  }
  expect((await request(base, 'reader')).body).toMatchObject({ status: 200, data: { count: 0, list: [], page: 1, limit: 15 } });
  expect((await request(base, 'reader', '', 'POST', body())).body.status).toBe(400011);
  for (const suffix of ['/products', '/brands', '/labels']) expect((await request(base, 'reader', suffix)).body.status).toBe(200);
  const input = body(), created = await request(base, 'manager', '', 'POST', input);
  expect(created.body.status).toBe(200); expect(created.cache).toContain('no-store');
  const id = created.body.data.id;
  expect((await request(base, 'manager', '', 'POST', input)).body.data.id).toBe(id);
  let detail = await request(base, 'reader', `/${id}`);
  expect(detail.body).toMatchObject({ status: 200, data: { info: { id, promotionsType: 6, product_id: [1], product_count: 1 } } });
  expect(detail.cache).toContain('no-store');
  expect((await request(base, 'manager', '/101')).body.status).toBe(404);
  expect((await request(base, 'reader', `/${id}/status`, 'PATCH', { status: 0, revision: detail.body.data.info.revision, request_id: crypto.randomUUID() })).body.status).toBe(400011);
  expect((await request(base, 'manager', `/${id}`, 'PUT', { ...body(), name: 'HTTP背景更新', revision: detail.body.data.info.revision })).body.status).toBe(200);
  detail = await request(base, 'manager', `/${id}`);
  expect((await request(base, 'manager', `/${id}/status`, 'PATCH', { status: 0, revision: detail.body.data.info.revision, request_id: crypto.randomUUID() })).body.status).toBe(200);
  detail = await request(base, 'manager', `/${id}`);
  expect((await request(base, 'manager', `/${id}`, 'DELETE', { revision: detail.body.data.info.revision, request_id: crypto.randomUUID() })).body.status).toBe(200);
  expect((await request(base, 'reader', `/${id}`)).body.status).toBe(404);
}, 30_000);
