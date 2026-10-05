/** Actual registered routes, JWT verification and SQL roles. Only database
 * connection wiring is test-owned; no permission/service/controller mock. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { systemAdmin, systemMenus, systemRole } from '../src/models/schema';
import { createToken, md5 } from '../src/utils/jwt';
import { integralBatchRuntimeFixture } from './helpers/integralBatchRuntimeFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({
  ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Integral batch HTTP fixture unavailable'); return wiring.container; },
}));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('registered integral bulk API with actual Admin JWT and SQL roles', () => {
  let f: Awaited<ReturnType<typeof integralBatchRuntimeFixture>>;
  const app = createApp(), tokens = new Map<number, string>();
  const actors = { manager: 7, reader: 8, single: 9, bulkPage: 10, bulkApi: 11,
    wrongMethod: 12, wrongPath: 13, generic: 14, otherManager: 15 };
  beforeEach(async () => {
    f = await integralBatchRuntimeFixture();
    await f.db.insert(systemMenus).values([
      { id: 931, type: 1, authType: 1, access: 1, uniqueAuth: 'marketing-store_integral-create', menuPath: '/admin/marketing/store_integral/create' },
      { id: 933, type: 1, authType: 1, access: 1, uniqueAuth: 'marketing-store_integral-create', menuPath: '/admin/marketing/store_integral/add_store_integral' },
      { id: 935, type: 1, authType: 2, access: 1, apiUrl: 'marketing/integral/batch', methods: 'POST' },
      { id: 9360, type: 1, authType: 2, access: 1, apiUrl: 'marketing/integral/batch', methods: 'GET' },
      { id: 9330, type: 1, authType: 1, access: 1, uniqueAuth: 'marketing-store_integral-create', menuPath: '/admin/marketing/store_integral/create/1' },
    ]);
    const rules: Record<string, string> = { manager: 'integral_batch.manage', reader: 'integral_batch.view',
      single: '931', bulkPage: '933', bulkApi: '935', wrongMethod: '9360', wrongPath: '9330',
      generic: 'activity.manage', otherManager: 'integral_batch.manage' };
    await f.db.insert(systemRole).values(Object.entries(actors).map(([name, id]) => ({ id, type: 1, roleName: name, rules: rules[name] })));
    await f.db.insert(systemAdmin).values(Object.entries(actors).map(([name, id]) => ({ id,
      account: `integral-${name}`, pwd: 'integral-http-fixture', level: 1, roles: String(id),
      adminType: 1, status: 1, isDel: 0 })));
    for (const id of Object.values(actors)) tokens.set(id,
      (await createToken(id, 'admin', md5('integral-http-fixture'), f.env.APP_KEY)).token);
  }, 30_000);
  afterEach(async () => { wiring.container = undefined; tokens.clear(); await f?.close(); }, 30_000);

  async function profiles(run: () => Promise<void>) {
    await f.withRuntimeRole(app => f.withRuntimeRole(async admin => {
      await f.installSlice(app, 'app'); await f.installSlice(admin, 'admin');
      expect((await app.exec('SELECT current_user,session_user'))[0]).toEqual({ current_user: app.role, session_user: app.role });
      expect((await admin.exec('SELECT current_user,session_user'))[0]).toEqual({ current_user: admin.role, session_user: admin.role });
      expect(app.pid).not.toBe(admin.pid);
      wiring.container = createContainerFromDb(app.db);
      Object.assign(f.env, { HYPERDRIVE: { connectionString: app.connectionString } as Env['HYPERDRIVE'],
        HYPERDRIVE_ADMIN: { connectionString: admin.connectionString } as Env['HYPERDRIVE_ADMIN'], NODE_ENV: 'test' });
      try { await run(); } finally { wiring.container = undefined; }
    }));
  }

  const request = async (prefix: string, actor: number | null, path = '', method = 'GET', data?: unknown, raw?: string) => {
    const response = await app.request(`${prefix}/activity/integral-batch${path}`, {
      method, headers: { ...(actor === null ? {} : { Authorization: `Bearer ${tokens.get(actor)}` }),
        ...(data === undefined && raw === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(raw !== undefined ? { body: raw } : data === undefined ? {} : { body: JSON.stringify(data) }),
    }, f.env);
    return { response, cache: response.headers.get('Cache-Control'), body: await response.json<{ status: number; msg: string; data: any }>() };
  };

  it.each(['/adminapi', '/api/admin'])('enforces the complete four-route contract on %s', async prefix => {
    await profiles(async () => {
    const input = await f.input();
    for (const id of [null, actors.reader, actors.single, actors.wrongMethod, actors.wrongPath, actors.generic]) {
      const denied = await request(prefix, id, '', 'POST', input);
      expect(denied.body.status).toBe(id === null ? 410000 : 400011);
      expect(denied.cache).toContain('no-store');
    }
    const list = await request(prefix, actors.reader, '/products?category_id=20&label_id=22');
    expect(list.body.status, list.body.msg).toBe(200);
    expect(list.body).toMatchObject({ status: 200, data: { count: 1, list: [{ id: 70 }] } });
    const source = await request(prefix, actors.reader, '/products/70');
    expect(source.body).toMatchObject({ status: 200, data: { product: { id: 70 }, skus: [
      { base_unique: 'base0070', stock: 8 }, { base_unique: 'blue0070', stock: 12 }] } });
    expect(source.cache).toContain('no-store');
    expect((await request(prefix, null, '/products')).body.status).toBe(410000);
    const created = await request(prefix, actors.manager, '', 'POST', input);
    expect(created.body.status, created.body.msg).toBe(200);
    expect(created.body.data.count).toBe(2); expect(created.cache).toContain('no-store');
    expect((await request(prefix, actors.manager, `/receipts/${input.request_id}`)).body.data).toEqual(created.body.data);
    expect((await request(prefix, actors.manager, '', 'POST', input)).body.data).toEqual(created.body.data);
    expect((await request(prefix, actors.otherManager, `/receipts/${input.request_id}`)).body.status).not.toBe(200);
    expect((await request(prefix, actors.otherManager, '', 'POST', input)).body.status).not.toBe(200);
    expect((await f.snapshot()).integrals).toHaveLength(2);
    });
  });

  it.each([['page-933', 10], ['api-935', 11]] as const)('admits the exact legacy bulk permission %s without requiring single-create permission', async (_name, actor) => {
    await profiles(async () => {
    const input = await f.input();
    const selection = await request('/adminapi', actor, '/products');
    expect(selection.body.status, selection.body.msg).toBe(200);
    const result = await request('/adminapi', actor, '', 'POST', input);
    expect(result.body.status, result.body.msg).toBe(200);
    expect(result.body.data.products).toHaveLength(2);
    });
  });

  it.each(['missing-key', 'non-uuid', 'wrong-show', 'duplicate-product', 'duplicate-sku',
    'empty-products', 'empty-skus', 'float-quota', 'zero-quota', 'negative-integral', 'fractional-integral',
    'negative-price', 'fractional-money', 'number-money', 'money-exponent',
    'free-both', 'unknown-field', 'forged-stock', 'image-script', 'image-signed-preview',
    'foreign-asset', 'too-many-products', 'too-many-skus'] as const)
    ('rejects %s request data before any business write', async invalid => {
      await profiles(async () => {
      const input: any = await f.input();
      const sku = input.products[0].skus[0];
      if (invalid === 'missing-key') delete input.request_id;
      if (invalid === 'non-uuid') input.request_id = 'one-off';
      if (invalid === 'wrong-show') input.is_show = '1';
      if (invalid === 'duplicate-product') input.products.push(structuredClone(input.products[0]));
      if (invalid === 'duplicate-sku') input.products[0].skus.push(structuredClone(sku));
      if (invalid === 'empty-products') input.products = [];
      if (invalid === 'empty-skus') input.products[0].skus = [];
      if (invalid === 'float-quota') sku.quota = 1.5;
      if (invalid === 'zero-quota') sku.quota = 0;
      if (invalid === 'negative-integral') sku.integral = -1;
      if (invalid === 'fractional-integral') sku.integral = 1.5;
      if (invalid === 'negative-price') sku.price = '-1.00';
      if (invalid === 'fractional-money') sku.price = '1.001';
      if (invalid === 'number-money') sku.price = 1;
      if (invalid === 'money-exponent') sku.price = '1e2';
      if (invalid === 'free-both') { sku.price = '0.00'; sku.integral = 0; }
      if (invalid === 'unknown-field') input.attrs = [];
      if (invalid === 'forged-stock') sku.stock = 999;
      if (invalid === 'image-script') sku.image = 'javascript:alert(1)';
      if (invalid === 'image-signed-preview') sku.image = '/api/assets/41?signature=untrusted&expires=9999999999';
      if (invalid === 'foreign-asset') sku.image = '/api/assets/43';
      if (invalid === 'too-many-products') input.products = Array.from({ length: 101 }, (_, i) => ({ ...input.products[0], product_id: i + 1 }));
      if (invalid === 'too-many-skus') input.products[0].skus = Array.from({ length: 501 }, (_, i) => ({ ...sku, base_unique: String(i).padStart(8, '0') }));
      const before = await f.snapshot();
      const rejected = await request('/adminapi', actors.manager, '', 'POST', input);
      expect(rejected.body.status, rejected.body.msg).toBe(400);
      expect(rejected.cache).toContain('no-store');
      expect(await f.snapshot()).toEqual(before);
      });
    });

  it('rejects invalid JSON, non-object bodies and oversized bodies with no graph or receipt', async () => {
    await profiles(async () => {
    const before = await f.snapshot();
    for (const raw of ['{', '[]', 'null', JSON.stringify({ giant: 'x'.repeat(1_100_000) })]) {
      const response = await request('/adminapi', actors.manager, '', 'POST', undefined, raw);
      expect(response.body.status, response.body.msg).toBe(400);
      expect(await f.snapshot()).toEqual(before);
    }
    });
  });
});
