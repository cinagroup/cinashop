import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { storeCombination, storePink, storeProduct, storeProductAttrValue, systemAdmin, systemLog, systemRole } from '../src/models/schema';
import type { AdminCombinationService } from '../src/services/admin/AdminCombinationService';
import { createToken, md5 } from '../src/utils/jwt';
import { combinationEdit, combinationInput } from './helpers/combinationAdminFixture';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';

// Actual assembled Hono routes, JWT/account/permission middleware, controllers,
// registered schema and independently authenticated commissioned SQL roles.
// Only the application binding is redirected to the owned fixture connection.
// The Admin session factory is real: it opens/closes its own restricted LOGIN
// from HYPERDRIVE_ADMIN for every authorized request. No SQL/service mocks,
// private grants, external providers or production connection fallback.
const wiring = vi.hoisted(() => ({ application: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({ ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => {
    if (!wiring.application) throw Error('Owned HTTP application LOGIN unavailable');
    return wiring.application;
  },
}));

const prefixes = ['/adminapi/activity/combinations', '/api/admin/activity/combinations'];
const manager = 4101, reader = 4102, unrelated = 4103, password = 'synthetic-combination-http-digest';
type Detail = Awaited<ReturnType<AdminCombinationService['detail']>>;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected complete HTTP object');
  return value as Record<string, unknown>;
}
async function envelope(response: Response) {
  const value = object(await response.json());
  if (typeof value.status !== 'number' || typeof value.msg !== 'string' || !Object.hasOwn(value, 'data')) throw Error('Malformed HTTP envelope');
  return { status: value.status, msg: value.msg, data: value.data };
}
function returnedId(value: unknown) {
  const id = object(value).id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw Error('Missing mutation identity');
  return id;
}
function noStore(response: Response) {
  expect(response.headers.get('Cache-Control')).toContain('private');
  expect(response.headers.get('Cache-Control')).toContain('no-store');
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Assembled combination HTTP on formal schema and exact app/Admin LOGINs', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  const http = createApp();
  const tokens = new Map<number, string>();
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture(); f.env.APP_KEY = 'local-combination-http-signing-key';
    await f.db.update(storeProduct).set({ isVerify: 1, isVipProduct: 0, isPresaleProduct: 0,
      sliderImage: '["/images/http-owned.png"]' }).where(eq(storeProduct.id, 70));
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),(SELECT max(id) FROM store_product_attr_value),true)");
    await f.db.insert(systemRole).values([
      { id: manager, roleName: 'Combination manager', rules: 'combination.manage' },
      { id: reader, roleName: 'Combination reader', rules: 'combination.view' },
      { id: unrelated, roleName: 'Generic activity only', rules: 'activity.manage' },
    ]);
    await f.db.insert(systemAdmin).values([manager, reader, unrelated].map(id => ({ id, account: `local-http-${id}`,
      pwd: password, roles: String(id), level: 1, adminType: 1, status: 1, isDel: 0 })));
    tokens.clear();
    for (const id of [manager, reader, unrelated]) tokens.set(id, (await createToken(id, 'admin', md5(password), f.env.APP_KEY)).token);
  }, 60000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { wiring.application = undefined; tokens.clear(); vi.restoreAllMocks(); await f?.close(); }
  }, 30000);
  type Role = Parameters<NonNullable<typeof f.withRuntimeRole>>[0] extends (role: infer R) => unknown ? R : never;
  async function profiles(run: (env: Env, admin: Role) => Promise<void>) {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      const [identity] = await f.exec('SELECT current_database() AS database'), names = { app: app.role, admin: admin.role, maintenance: 'finance_test' };
      await runRuntimeBusinessCommissioning(f.db, { ...names, database: String(identity.database), pricingOwner: f.pricingOwner });
      expect(await auditRuntimeBusinessPrivileges(app.db, 'app', names)).toMatchObject({ ready: true, failures: [] });
      expect(await auditRuntimeBusinessPrivileges(admin.db, 'admin', names)).toMatchObject({ ready: true, failures: [] });
      expect((await admin.exec('SELECT current_user AS role, session_user AS session'))[0]).toEqual({ role: admin.role, session: admin.role });
      wiring.application = createContainerFromDb(app.db);
      const env: Env = { ...f.env, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
        HYPERDRIVE: { connectionString: app.connectionString } as Env['HYPERDRIVE'],
        HYPERDRIVE_ADMIN: { connectionString: admin.connectionString } as Env['HYPERDRIVE_ADMIN'] };
      // The local fixture exercises the supported no-Redis JWT path. The
      // generated deployment binding types intentionally contain production.
      Object.assign(env, { NODE_ENV: 'test' });
      try { await run(env, admin); } finally { wiring.application = undefined; }
    }));
  }
  const input = () => combinationInput({ product_id: 70, shipping: { delivery_type: [1], freight: 2, postage: '3.00', temp_id: 0 },
    skus: [{ id: null, base_unique: 'qared001', enabled: true, price: '6.25', quota_total: 5, image: '/images/http-owned-sku.png' }] });
  const send = (env: Env, path: string, method = 'GET', body?: unknown, actor = manager) => http.request(path, {
    method, headers: { 'Authori-zation': `Bearer ${tokens.get(actor)}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
  async function readDetail(env: Env, path: string) {
    const response = await send(env, path); noStore(response);
    const result = await envelope(response); expect(result.status).toBe(200);
    const data = object(result.data);
    expect(data).toMatchObject({ id: expect.any(Number), revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      images: expect.any(Array), skus: expect.any(Array), shipping: expect.any(Object), description_preview: expect.any(String) });
    return data as Detail;
  }
  const snapshot = async () => {
    const state: Record<string, unknown> = {};
    for (const table of ['store_combination', 'store_pink', 'store_product', 'store_product_attr_value', 'store_product_attr',
      'store_product_attr_result', 'store_product_description', 'store_product_sku_retirement_log', 'system_log'])
      state[table] = (await f.query(`SELECT to_jsonb(t) AS row FROM public."${table}" t ORDER BY to_jsonb(t)::text`)).rows;
    return state;
  };

  it.each(prefixes)('executes all nine real %s routes, replay and legacy soft-delete semantics', async base => {
    await profiles(async (env, admin) => {
      const sourceBefore = await f.db.select().from(storeProduct), basesBefore = (await f.db.select().from(storeProductAttrValue)).filter(row => row.type === 0);
      const before = await snapshot();
      for (const path of [base, `${base}/options`, `${base}/products`, `${base}/products/70`]) {
        const response = await send(env, path); noStore(response); const result = await envelope(response); expect(result.status).toBe(200);
        if (path.endsWith('/options')) expect(result.data).toMatchObject({ max_skus: 500, max_images: 10 });
        else if (path.endsWith('/products')) expect(object(result.data).list).toEqual(expect.arrayContaining([expect.objectContaining({ product_id: 70 })]));
        else if (path.endsWith('/products/70')) expect(result.data).toMatchObject({ product_id: 70, owner: { type: 2, relation_id: 7 }, skus: expect.any(Array) });
        else expect(result.data).toMatchObject({ count: 0, list: [], page: 1, limit: 15 });
      }
      expect(await snapshot()).toEqual(before);
      const body = input(), created = await send(env, base, 'POST', body); noStore(created);
      const first = await envelope(created); expect(first.status).toBe(200); const id = returnedId(first.data);
      const other = prefixes.find(prefix => prefix !== base)!;
      expect(await envelope(await send(env, other, 'POST', body))).toMatchObject({ status: 200, data: { id } });
      const initial = await readDetail(env, `${base}/${id}`), edit = combinationEdit(initial, { title: 'HTTP原位编辑' });
      edit.skus[0].quota_total = 6;
      const updated = await send(env, `${base}/${id}`, 'PUT', edit); noStore(updated); expect(await envelope(updated)).toMatchObject({ status: 200, data: { id } });
      const current = await readDetail(env, `${other}/${id}`);
      expect(current.title).toBe('HTTP原位编辑'); expect(current.skus[0]).toMatchObject({ id: initial.skus[0].id, unique: initial.skus[0].unique, quota_total: 6 });
      const originalDeadline = new Date(Date.now() + 86400000);
      await f.db.insert(storePink).values({ id: 4101, combinationId: id, productId: 70, uid: 11, people: 3, status: 1, stopTime: originalDeadline });
      const off = await send(env, `${base}/${id}/status`, 'PUT', { revision: current.revision, request_id: crypto.randomUUID(), status: 0 });
      noStore(off); expect(await envelope(off)).toMatchObject({ status: 200, data: { id } });
      const [closedPink] = await f.db.select().from(storePink).where(eq(storePink.id, 4101));
      expect(closedPink.stopTime!.getTime()).toBeLessThan(originalDeadline.getTime());
      const closed = await readDetail(env, `${base}/${id}`);
      expect(closed.status).toBe(0);
      expect(await envelope(await send(env, `${base}/${id}/status`, 'PUT', { revision: closed.revision, request_id: crypto.randomUUID(), status: 1 }))).toMatchObject({ status: 200, data: { id } });
      await f.db.insert(storePink).values({ id: 4102, combinationId: id, productId: 70, uid: 11, people: 3, status: 1, stopTime: originalDeadline });
      const reopened = await readDetail(env, `${base}/${id}`), pinks = await f.db.select().from(storePink).orderBy(storePink.id);
      const key = { revision: reopened.revision, request_id: crypto.randomUUID() }, deleted = await send(env, `${base}/${id}`, 'DELETE', key);
      noStore(deleted); expect(await envelope(deleted)).toMatchObject({ status: 200, data: { id } });
      expect(await envelope(await send(env, `${other}/${id}`, 'DELETE', key))).toMatchObject({ status: 200, data: { id } });
      expect((await admin.db.select().from(storeCombination).where(eq(storeCombination.id, id)))[0]).toMatchObject({ isDel: 1, status: 1, isShow: 1 });
      expect(await f.db.select().from(storePink).orderBy(storePink.id)).toEqual(pinks);
      const hidden = await send(env, `${base}/${id}`); noStore(hidden); expect(await envelope(hidden)).toMatchObject({ status: 404, data: null });
      expect(await envelope(await send(env, base))).toMatchObject({ status: 200, data: { count: 0, list: [] } });
      expect(await f.db.select().from(storeProduct)).toEqual(sourceBefore);
      expect((await f.db.select().from(storeProductAttrValue)).filter(row => row.type === 0)).toEqual(basesBefore);
      expect((await f.db.select().from(systemLog)).filter(row => row.type === 'combination')).toHaveLength(5);
      expect((await f.db.select().from(systemLog)).filter(row => row.type === 'combination').every(row => row.adminId === manager)).toBe(true);
    });
  }, 60000);

  it.each(prefixes)('enforces independent view/manage authorization before any Admin business writes on %s', async base => {
    await profiles(async env => {
      const created = await envelope(await send(env, base, 'POST', input())), id = returnedId(created.data), row = await readDetail(env, `${base}/${id}`);
      const before = await snapshot(), reads = [base, `${base}/options`, `${base}/products`, `${base}/products/70`, `${base}/${id}`];
      for (const path of reads) {
        const allowed = await send(env, path, 'GET', undefined, reader); noStore(allowed); expect((await envelope(allowed)).status).toBe(200);
        const denied = await send(env, path, 'GET', undefined, unrelated); noStore(denied); expect(await envelope(denied)).toMatchObject({ status: 400011, data: null });
      }
      const writes = [[base, 'POST', input()], [`${base}/${id}`, 'PUT', combinationEdit(row)],
        [`${base}/${id}/status`, 'PUT', { revision: row.revision, request_id: crypto.randomUUID(), status: 0 }],
        [`${base}/${id}`, 'DELETE', { revision: row.revision, request_id: crypto.randomUUID() }]] as const;
      for (const actor of [reader, unrelated]) for (const [path, method, body] of writes) {
        const denied = await send(env, path, method, body, actor); noStore(denied);
        expect(await envelope(denied)).toMatchObject({ status: 400011, data: null });
      }
      expect(await snapshot()).toEqual(before);
    });
  }, 60000);

  it.each(prefixes)('rejects UUID/revision/query/body violations without DML on the real %s surface', async base => {
    await profiles(async env => {
      const original = input(), created = await envelope(await send(env, base, 'POST', original)), id = returnedId(created.data), row = await readDetail(env, `${base}/${id}`), edit = combinationEdit(row);
      const before = await snapshot();
      const invalid = [
        [base, 'POST', { ...input(), request_id: 'not-a-uuid' }],
        [base, 'POST', { ...original, title: '复用UUID但更改内容' }],
        [base, 'POST', { ...input(), revision: row.revision }],
        [`${base}/${id}`, 'PUT', { ...edit, revision: 'bad' }],
        [`${base}/${id}`, 'PUT', { ...edit, revision: '0'.repeat(64) }],
        [`${base}/${id}/status`, 'PUT', { revision: row.revision, request_id: crypto.randomUUID(), status: '0' }],
        [`${base}/${id}`, 'DELETE', { request_id: crypto.randomUUID() }],
        [`${base}/options?page=1`, 'GET', undefined],
        [`${base}/products/70?unknown=1`, 'GET', undefined],
        [`${base}/${id}?unknown=1`, 'GET', undefined],
        [`${base}?page=1&page=2`, 'GET', undefined],
        [`${base}/products?label_id=1&label_id=2`, 'GET', undefined],
        [`${base}?limit=101`, 'GET', undefined],
        [`${base}?page=668&limit=15`, 'GET', undefined],
        [`${base}?unknown=1`, 'POST', input()],
        [`${base}/${id}?unknown=1`, 'PUT', edit],
        [`${base}/${id}/status?unknown=1`, 'PUT', { revision: row.revision, request_id: crypto.randomUUID(), status: 0 }],
        [`${base}/${id}?unknown=1`, 'DELETE', { revision: row.revision, request_id: crypto.randomUUID() }],
        [`${base}/not-an-id`, 'GET', undefined],
      ] as const;
      for (const [path, method, body] of invalid) {
        const rejected = await send(env, path, method, body); noStore(rejected);
        expect(await envelope(rejected)).toMatchObject({ status: 400, data: null });
      }
      const oversized = await send(env, base, 'POST', { ...input(), description: 'x'.repeat(768001) });
      noStore(oversized); expect(await envelope(oversized)).toMatchObject({ status: 400, msg: expect.stringContaining('750 KiB'), data: null });
      for (const body of ['[]', '{']) {
        const rejected = await http.request(base, { method: 'POST', headers: { 'Authori-zation': `Bearer ${tokens.get(manager)}`, 'Content-Type': 'application/json' }, body }, env);
        noStore(rejected); expect(await envelope(rejected)).toMatchObject({ status: 400, data: null });
      }
      expect(await snapshot()).toEqual(before);
    });
  }, 60000);

  it('rejects missing, invalid and signed non-Admin JWTs on both surfaces without exposing or writing the graph', async () => {
    await profiles(async env => {
      const customer = await createToken(manager, 'api', md5(password), env.APP_KEY), before = await snapshot();
      for (const base of prefixes) for (const token of ['', 'invalid-jwt', customer.token]) {
        const response = await http.request(base, { method: 'POST', headers: { 'Authori-zation': token ? `Bearer ${token}` : '', 'Content-Type': 'application/json' }, body: JSON.stringify(input()) }, env);
        noStore(response); expect((await envelope(response)).status).toBeGreaterThanOrEqual(410000);
      }
      expect(await snapshot()).toEqual(before);
    });
  }, 60000);
});
