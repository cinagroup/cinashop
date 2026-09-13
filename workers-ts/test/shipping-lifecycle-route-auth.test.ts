import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { createContainerFromDb } from '../src/lib/di';
import type { AppVariables, Env } from '../src/env';
import { adminapiRoutes } from '../src/routes/adminapi';
import { v1Routes } from '../src/routes/v1';
import { supplierapiRoutes } from '../src/routes/supplierapi';
import { errorHandler } from '../src/middleware/error';
import { createToken, md5, type TokenType } from '../src/utils/jwt';
import * as cache from '../src/utils/cache';
import { runShippingLifecycle } from '../src/migrations/runShippingLifecycle';

const surfaces = ['adminapi', 'api/admin', 'supplierapi'] as const;
type Surface = typeof surfaces[number];
type Operation = 'save' | 'delete';
const children = ['store_product', 'store_seckill', 'store_bargain', 'store_combination', 'store_integral', 'store_discounts_products'];
const shippingTables = ['shipping_templates', 'shipping_templates_region', 'shipping_templates_free', 'shipping_templates_no_delivery'];
const stateTables = [...shippingTables, ...children, 'store_order', 'system_admin', 'system_role', 'system_supplier'];

// Registered routes, real JWT verification, DB principals/role resolution and
// controllers/services with the formal protocol installed on full isolated ORM.
// Only token-bucket storage is substituted. No login/provider/online-role claim.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(['maintenance', 'restricted LOGIN'] as const)('shipping lifecycle registered-route authorization on full PG16: %s', identity => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  let env: Env;
  let buckets: Map<string, cache.TokenBucket>;
  let omittedGrant: string | undefined;
  let pooledRuntime: SequenceRunnerPeer | undefined;
  const asRuntime = (callback: (runtime: SequenceRunnerPeer & { role: string }) => Promise<void>) => f.withRuntimeRole!(async runtime => {
    // Template-management scope only: reference tables are read-only. This is
    // deliberately not the broader seven-table writer permission envelope.
    await f.exec(`GRANT SELECT,INSERT,UPDATE ON public.shipping_templates TO "${runtime.role}";
      GRANT SELECT ON ${children.map(t => `public.${t}`).join(',')},public.system_admin,public.system_role,public.system_supplier,public.system_city TO "${runtime.role}";
      GRANT SELECT,INSERT,DELETE ON ${shippingTables.slice(1).map(t => `public.${t}`).join(',')} TO "${runtime.role}";
      GRANT USAGE ON SEQUENCE ${shippingTables.map(t => `public.${t}_id_seq`).join(',')} TO "${runtime.role}"`);
    if (omittedGrant) await f.exec(`REVOKE ${omittedGrant} FROM "${runtime.role}"`);
    await callback(runtime);
  });
  beforeAll(async () => {
    f = await sequenceRunnerDatabase();
    const api = await import('drizzle-kit/api'), models = await import('../src/models/schema');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
    await runShippingLifecycle(f.db);
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      if (pooledRuntime) { c.set('container', createContainerFromDb(pooledRuntime.db)); await next(); }
      else if (identity === 'maintenance') { c.set('container', createContainerFromDb(f.db)); await next(); }
      else await asRuntime(async runtime => { c.set('container', createContainerFromDb(runtime.db)); await next(); });
    });
    app.onError(errorHandler);
    app.route('/adminapi', adminapiRoutes); app.route('/api', v1Routes); app.route('/supplierapi', supplierapiRoutes);
  }, 120000);
  afterAll(async () => { await f?.close(); }, 45000);
  beforeEach(async () => {
    omittedGrant = undefined;
    pooledRuntime = undefined;
    buckets = new Map();
    env = { APP_KEY: crypto.randomUUID(), NODE_ENV: 'production', UPSTASH_REDIS_URL: 'https://isolated-token-bucket.invalid',
      UPSTASH_REDIS_TOKEN: 'isolated-not-a-provider-credential' } as Env;
    vi.spyOn(cache, 'getTokenBucket').mockImplementation(async key => buckets.get(key) ?? null);
    vi.spyOn(cache, 'clearToken').mockImplementation(async key => buckets.delete(key));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('External I/O forbidden in shipping authorization acceptance'); }));
    for (const table of [...children.slice(1), children[0], ...shippingTables.slice(1), shippingTables[0], 'system_admin', 'system_role', 'system_supplier', 'store_order'])
      await f.exec(`DELETE FROM public.${table}`);
    await f.exec("DELETE FROM system_city; INSERT INTO system_city(city_id,parent_id,name) VALUES(101,0,'isolated province'),(102,101,'isolated city'); SELECT setval('shipping_templates_id_seq',10000)");
    await f.exec(`INSERT INTO system_role(id,type,relation_id,rules,status) VALUES
      (1,1,0,'shipping.manage',1),(2,4,20,'supplier.shipping.manage',1),(3,4,30,'supplier.shipping.manage',1);
      INSERT INTO system_admin(id,account,admin_type,relation_id,roles,level) VALUES
      (7,'isolated-platform',1,0,'1',1),(27,'isolated-supplier-child',4,20,'2',1),(28,'isolated-supplier-primary',4,20,'',1);
      INSERT INTO system_supplier(id,admin_id,supplier_name) VALUES(20,28,'isolated-own'),(30,38,'isolated-other');
      INSERT INTO shipping_templates(id,name,owner_type,relation_id) VALUES(1,'default',0,0),(10,'platform',0,0),(20,'own',2,20),(30,'foreign',2,30);
      INSERT INTO shipping_templates_region(template_id,first_price) VALUES(10,'6.00'),(20,'7.00'),(30,'8.00');
      INSERT INTO store_product(id,temp_id,freight,type,relation_id) VALUES(100,0,1,0,0),(200,0,1,2,20);
      INSERT INTO store_order(id,order_id,pay_postage,cart_id) VALUES(999,'auth-history','12.34','[77]')`);
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const snapshot = () => f.query(`SELECT jsonb_build_object(${stateTables.map(t => `'${t}',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.${t} t)`).join(',')}) AS state`);
  const token = async (surface: Surface, options: { id?: number; type?: TokenType; badKey?: boolean; expired?: boolean } = {}) => {
    const id = options.id ?? (surface === 'supplierapi' ? 27 : 7), type = options.type ?? (surface === 'supplierapi' ? 'supplier' : 'admin');
    const issued = await createToken(id, type, md5(''), options.badKey ? crypto.randomUUID() : env.APP_KEY,
      'cinashop', options.expired ? Math.floor(Date.now() / 1000) - 40 * 86400 : undefined);
    buckets.set(md5(issued.token), { ...issued, uid: id, type });
    return issued.token;
  };
  const request = async (surface: Surface, operation: Operation, bearer: string, id = surface === 'supplierapi' ? 20 : 10, override: Record<string, unknown> = {}) => {
    const supplier = surface === 'supplierapi';
    const path = supplier ? `/supplierapi/setting/shipping_templates/${operation === 'save' ? 'save' : 'del'}/${id}`
      : `/${surface}/shipping_template/${operation === 'save' ? 'save' : `del/${id}`}`;
    const body = supplier ? { name: 'explicit edit', type: 1, appoint: 0, no_delivery: 0, sort: 0,
      region_info: [{ city_ids: [[0]], first: '1', first_price: '9', continue: '1', continue_price: '2' }],
      appoint_info: [], no_delivery_info: [],
      supplierId: 30, relation_id: 30, owner_type: 0 }
      : { id, name: 'explicit edit', status: 0, adminId: 999, roles: 'shipping.manage' };
    const response = await app.request(path, { method: operation === 'save' ? 'POST' : 'DELETE',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'x-admin-id': '7', 'x-supplier-id': '30' },
      ...(operation === 'save' ? { body: JSON.stringify({ ...body, ...override }) } : {}) }, env);
    return { http: response.status, body: await response.json() as { status: number; msg: string; data: unknown } };
  };
  const denials = ['absent', 'signature', 'expired', 'revoked', 'bucket_owner', 'wrong_type', 'jwt_type', 'banned', 'deleted', 'password', 'view_only', 'role_disabled', 'role_missing'] as const;
  const fullRules = {
    appoint: 1, no_delivery: 1,
    region_info: [{ city_ids: [[0], [101,102]], first: '1', first_price: '9', continue: '1', continue_price: '2' }],
    appoint_info: [{ city_ids: [[101,102]], number: '2', price: '20' }],
    no_delivery_info: [{ city_ids: [[101]] }],
  };
  for (const surface of surfaces) describe(surface, () => {
    it('creates auto-ID templates, replaces nonempty rules, reads and retires without order-table privileges', async () => {
      const bearer = await token(surface), supplier = surface === 'supplierapi';
      const stable = () => f.query("SELECT jsonb_build_object('orders',(SELECT jsonb_agg(to_jsonb(t)) FROM store_order t),'existing',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM shipping_templates t WHERE id<=30)) AS state");
      const before = await stable();
      const form = supplier ? fullRules : { regions: [{ region_id: 102, region_name: 'isolated city', first_price: '9' }], status: 1 };
      expect((await request(surface, 'save', bearer, 0, form)).body.status).toBe(200);
      const [created] = (await f.query('SELECT id,owner_type,relation_id FROM shipping_templates WHERE id>30')).rows as Array<{ id: number; owner_type: number; relation_id: number }>;
      expect(created).toMatchObject({ id: 10001, owner_type: supplier ? 2 : 0, relation_id: supplier ? 20 : 0 });
      expect((await request(surface, 'save', bearer, created.id, form)).body.status).toBe(200);
      expect((await f.query(`SELECT count(*)::int AS count FROM shipping_templates_region WHERE template_id=${created.id}`)).rows).toEqual([{ count: supplier ? 2 : 1 }]);
      if (supplier) {
        for (const table of shippingTables.slice(2)) expect((await f.query(`SELECT count(*)::int AS count FROM ${table} WHERE temp_id=${created.id}`)).rows).toEqual([{ count: 1 }]);
        for (const path of [`/supplierapi/setting/shipping_templates/${created.id}/edit`, '/supplierapi/setting/shipping_templates/city_list']) {
          const response = await app.request(path, { headers: { Authorization: `Bearer ${bearer}` } }, env);
          expect((await response.json() as { status: number }).status).toBe(200);
        }
      }
      expect((await request(surface, 'delete', bearer, created.id)).body.status).toBe(200);
      expect((await f.query(`SELECT is_del FROM shipping_templates WHERE id=${created.id}`)).rows).toEqual([{ is_del: 1 }]);
      for (const table of shippingTables.slice(1)) {
        const key = table === 'shipping_templates_region' ? 'template_id' : 'temp_id';
        expect((await f.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${key}=${created.id}`)).rows).toEqual([{ count: !supplier && key === 'template_id' ? 1 : 0 }]);
      }
      expect(await stable()).toEqual(before);
    });
    for (const operation of ['save', 'delete'] as const) it.each(denials)(`${operation} rejects %s before any shipping/history mutation`, async kind => {
      let bearer = await token(surface, { badKey: kind === 'signature', expired: kind === 'expired', type: ['wrong_type','jwt_type'].includes(kind) ? 'api' : undefined });
      const actor = surface === 'supplierapi' ? 27 : 7, role = surface === 'supplierapi' ? 2 : 1;
      if (kind === 'absent') bearer = '';
      if (kind === 'revoked') buckets.delete(md5(bearer));
      if (kind === 'bucket_owner') buckets.get(md5(bearer))!.uid = 999;
      // Inconsistent isolated bucket forces execution of the independent JWT
      // type guard; normal cross-surface buckets are rejected one layer earlier.
      if (kind === 'jwt_type') buckets.get(md5(bearer))!.type = surface === 'supplierapi' ? 'supplier' : 'admin';
      if (kind === 'banned') await f.exec(`UPDATE system_admin SET status=0 WHERE id=${actor}`);
      if (kind === 'deleted') await f.exec(`UPDATE system_admin SET is_del=1 WHERE id=${actor}`);
      if (kind === 'password') await f.exec(`UPDATE system_admin SET pwd='changed-after-issuance' WHERE id=${actor}`);
      if (kind === 'view_only') await f.exec(`UPDATE system_role SET rules='${surface === 'supplierapi' ? 'supplier.shipping.view' : 'shipping.view'}' WHERE id=${role}`);
      if (kind === 'role_disabled') await f.exec(`UPDATE system_role SET status=0 WHERE id=${role}`);
      if (kind === 'role_missing') await f.exec(`DELETE FROM system_role WHERE id=${role}`);
      const expected = ['view_only','role_disabled','role_missing'].includes(kind) ? 400011
        : ['signature','expired','password'].includes(kind) ? 410001
        : ['absent','revoked','wrong_type'].includes(kind) ? 410000 : 410002;
      const before = await snapshot();
      expect(await request(surface, operation, bearer)).toMatchObject({ http: 200, body: { status: expected, data: null } });
      expect(await snapshot()).toEqual(before);
    });
    it('permitted edit and delete keep historical orders and unrelated owners unchanged', async () => {
      const bearer = await token(surface), id = surface === 'supplierapi' ? 20 : 10;
      const stable = () => f.query(`SELECT jsonb_build_object('orders',(SELECT jsonb_agg(to_jsonb(t)) FROM store_order t),
        'other',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM shipping_templates t WHERE id<>${id})) AS state`);
      const before = await stable();
      expect((await request(surface, 'save', bearer)).body).toMatchObject({ status: 200 });
      expect((await request(surface, 'delete', bearer)).body.status).toBe(200);
      expect((await f.query(`SELECT is_del FROM shipping_templates WHERE id=${id}`)).rows).toEqual([{ is_del: 1 }]);
      expect(await stable()).toEqual(before);
    });
    it('manage capability does not bypass retained-reference retirement protection', async () => {
      const id = surface === 'supplierapi' ? 20 : 10, product = surface === 'supplierapi' ? 200 : 100;
      await f.exec(`UPDATE store_product SET temp_id=${id},freight=3 WHERE id=${product}`);
      const before = await snapshot();
      expect((await request(surface, 'delete', await token(surface))).body).toMatchObject({ status: 400, msg: '运费模板仍被商品或活动引用，请先解除引用' });
      expect(await snapshot()).toEqual(before);
    });
    it('reloads revoked role permissions on the next request with the same signed token', async () => {
      const bearer = await token(surface), role = surface === 'supplierapi' ? 2 : 1;
      expect((await request(surface, 'save', bearer)).body).toMatchObject({ status: 200 });
      await f.exec(`UPDATE system_role SET rules='' WHERE id=${role}`);
      const before = await snapshot();
      expect((await request(surface, 'delete', bearer)).body.status).toBe(400011);
      expect(await snapshot()).toEqual(before);
    });
    it('view-only role can read its registered list without acquiring write capability', async () => {
      const role = surface === 'supplierapi' ? 2 : 1;
      await f.exec(`UPDATE system_role SET rules='${surface === 'supplierapi' ? 'supplier.shipping.view' : 'shipping.view'}' WHERE id=${role}`);
      const bearer = await token(surface), before = await snapshot();
      const path = surface === 'supplierapi' ? '/supplierapi/setting/shipping_templates/list' : `/${surface}/shipping_template/list`;
      const response = await app.request(path, { headers: { Authorization: `Bearer ${bearer}` } }, env);
      expect((await response.json() as { status: number }).status).toBe(200);
      expect((await request(surface, 'delete', bearer)).body.status).toBe(400011);
      expect(await snapshot()).toEqual(before);
    });
  });
  it.each(['adminapi','api/admin'] as const)('%s refuses a non-platform account even with a valid admin JWT and manage role', async surface => {
    const bearer = await token(surface);
    await f.exec('UPDATE system_admin SET admin_type=2 WHERE id=7');
    const before = await snapshot();
    expect((await request(surface, 'delete', bearer)).body.status).toBe(410002);
    expect(await snapshot()).toEqual(before);
  });
  it('supplier primary bypasses role assignment but cannot bypass retained references or tenant scope', async () => {
    const bearer = await token('supplierapi', { id: 28 });
    expect((await request('supplierapi', 'save', bearer)).body.status).toBe(200);
    await f.exec('UPDATE store_product SET temp_id=20,freight=3 WHERE id=200');
    const before = await snapshot();
    expect((await request('supplierapi', 'delete', bearer)).body.status).toBe(400);
    expect((await request('supplierapi', 'delete', bearer, 30)).body.status).toBe(404);
    expect(await snapshot()).toEqual(before);
  });
  it.each(['save','delete'] as const)('supplier %s cannot touch another owner despite forged request identity', async operation => {
    const before = await snapshot();
    expect((await request('supplierapi', operation, await token('supplierapi'), 30)).body).toMatchObject({ status: 404 });
    expect(await snapshot()).toEqual(before);
  });
  it.each(['supplier_disabled','foreign_role','wrong_admin_type'] as const)('supplier rejects %s without changing shipping rows', async kind => {
    const bearer = await token('supplierapi');
    if (kind === 'supplier_disabled') await f.exec('UPDATE system_supplier SET is_show=0 WHERE id=20');
    if (kind === 'foreign_role') await f.exec("UPDATE system_admin SET roles='3' WHERE id=27");
    if (kind === 'wrong_admin_type') await f.exec('UPDATE system_admin SET admin_type=1 WHERE id=27');
    const before = await snapshot();
    expect((await request('supplierapi', 'delete', bearer)).body.status).toBe(kind === 'foreign_role' ? 400011 : 410002);
    expect(await snapshot()).toEqual(before);
  });
  if (identity === 'restricted LOGIN') {
    it('reuses the same LOGIN backend after rolled-back rule failure and revoked auth-read privileges', async () => {
      await asRuntime(async runtime => {
        pooledRuntime = runtime;
        try {
          const settings = () => runtime.exec("SELECT pg_backend_pid() AS pid,current_user=session_user AS same,current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle");
          const initial = await settings(), bearer = await token('supplierapi'), before = await snapshot();
          await f.exec(`REVOKE INSERT ON public.shipping_templates_no_delivery FROM "${runtime.role}"`);
          expect((await request('supplierapi', 'save', bearer, 20, fullRules)).body.status).toBe(500);
          expect(await snapshot()).toEqual(before);
          await f.exec(`GRANT INSERT ON public.shipping_templates_no_delivery TO "${runtime.role}"`);
          expect((await request('supplierapi', 'save', bearer, 20, fullRules)).body.status).toBe(200);
          const saved = await snapshot();
          await f.exec(`REVOKE SELECT ON public.system_role FROM "${runtime.role}"`);
          expect((await request('supplierapi', 'delete', bearer)).body.status).toBe(500);
          expect(await snapshot()).toEqual(saved);
          await f.exec(`GRANT SELECT ON public.system_role TO "${runtime.role}"`);
          await runtime.exec('RESET ROLE');
          expect((await request('supplierapi', 'delete', bearer)).body.status).toBe(200);
          expect(await settings()).toEqual(initial);
        } finally { pooledRuntime = undefined; }
      });
    });
    for (const surface of surfaces) it.each(['INSERT ON public.shipping_templates', 'USAGE ON SEQUENCE public.shipping_templates_id_seq'])(`${surface} cannot create without %s`, async grant => {
      omittedGrant = grant;
      const before = await snapshot();
      expect((await request(surface, 'save', await token(surface), 0, surface === 'supplierapi' ? fullRules : {})).body.status).toBe(500);
      expect(await snapshot()).toEqual(before);
    });
    it('has no maintenance, auth mutation, reference writer or order privileges and cannot recover them with RESET ROLE', async () => {
      await asRuntime(async runtime => {
        await runtime.exec('RESET ROLE');
        expect(await runtime.exec('SELECT current_user=session_user AS same,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user'))
          .toMatchObject([{ same: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }]);
        for (const statement of [
          'SELECT * FROM store_order', 'UPDATE system_admin SET level=0 WHERE id=7', 'UPDATE system_role SET status=0 WHERE id=1',
          'UPDATE system_supplier SET admin_id=27 WHERE id=20', 'UPDATE system_city SET name=\'changed\' WHERE city_id=101',
          ...children.map(t => `DELETE FROM ${t}`),
          'DELETE FROM shipping_templates WHERE id=10', 'TRUNCATE shipping_templates_region',
          'ALTER TABLE shipping_templates DISABLE TRIGGER ALL', 'CREATE TABLE public.forbidden_shipping(id integer)',
          "SET session_replication_role='replica'", "SELECT setval('shipping_templates_id_seq',1)",
        ]) await expect(runtime.exec(statement)).rejects.toMatchObject({ code: '42501' });
      });
    });
    it.each([
      'SELECT ON public.system_admin', 'SELECT ON public.system_role', 'SELECT ON public.system_supplier', 'SELECT ON public.system_city',
      'UPDATE ON public.shipping_templates',
      ...shippingTables.slice(1).flatMap(t => [`DELETE ON public.${t}`, `INSERT ON public.${t}`, `USAGE ON SEQUENCE public.${t}_id_seq`]),
    ])('missing %s fails closed and rolls back the entire supplier edit, including earlier rule deletes', async grant => {
      omittedGrant = grant;
      const before = await snapshot();
      expect(await request('supplierapi', 'save', await token('supplierapi'), 20, fullRules))
        .toMatchObject({ http: 200, body: { status: 500, msg: '系统繁忙,请稍后再试', data: null } });
      expect(await snapshot()).toEqual(before);
    });
    it.each(children)('cannot retire when retained-reference table %s is unreadable', async table => {
      omittedGrant = `SELECT ON public.${table}`;
      const before = await snapshot();
      expect((await request('supplierapi', 'delete', await token('supplierapi'))).body.status).toBe(500);
      expect(await snapshot()).toEqual(before);
    });
  }
});
