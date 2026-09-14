import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { createContainerFromDb } from '../src/lib/di';
import type { AppVariables, Env } from '../src/env';
import { supplierapiRoutes } from '../src/routes/supplierapi';
import { errorHandler } from '../src/middleware/error';
import { createToken, md5 } from '../src/utils/jwt';
import * as cache from '../src/utils/cache';

const optionsPath = '/supplierapi/product/product/shipping-template-options';
// Actual registered routes, JWT, database identity and permission middleware.
// Only Redis token storage is substituted; runtime SQL has SELECT-only grants.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('product-only shipping options on restricted PG16 LOGIN', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  let env: Env, bearer: string;
  let buckets: Map<string, cache.TokenBucket>;
  beforeAll(async () => {
    f = await sequenceRunnerDatabase();
    const kit = await import('drizzle-kit/api'), schema = await import('../src/models/schema');
    await f.exec((await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson(schema))).join('\n'));
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      await f.withRuntimeRole!(async runtime => {
        await f.exec(`GRANT SELECT ON public.shipping_templates,public.system_admin,public.system_supplier,public.system_role TO "${runtime.role}"`);
        c.set('container', createContainerFromDb(runtime.db)); await next();
      });
    });
    app.onError(errorHandler); app.route('/supplierapi', supplierapiRoutes);
  }, 120000);
  afterAll(async () => { await f?.close(); }, 45000);
  beforeEach(async () => {
    buckets = new Map();
    env = { APP_KEY: crypto.randomUUID(), NODE_ENV: 'production', UPSTASH_REDIS_URL: 'https://isolated.invalid', UPSTASH_REDIS_TOKEN: 'fixture-only' } as Env;
    vi.spyOn(cache, 'getTokenBucket').mockImplementation(async key => buckets.get(key) ?? null);
    vi.spyOn(cache, 'clearToken').mockImplementation(async key => buckets.delete(key));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('External I/O forbidden'); }));
    await f.exec(`DELETE FROM shipping_templates; DELETE FROM system_admin; DELETE FROM system_role; DELETE FROM system_supplier;
      INSERT INTO system_role(id,type,relation_id,rules,status) VALUES(2,4,20,'supplier.product.manage',1),(3,4,30,'supplier.product.view',1);
      INSERT INTO system_admin(id,account,admin_type,relation_id,roles,level) VALUES(27,'fixture-child',4,20,'2',1);
      INSERT INTO system_supplier(id,admin_id,supplier_name) VALUES(20,28,'own'),(30,38,'other');
      INSERT INTO shipping_templates(id,name,owner_type,relation_id,type,sort)
        SELECT 200+n,'template-'||n,2,20,1,0 FROM generate_series(1,125) n;
      INSERT INTO shipping_templates(id,name,owner_type,relation_id,type,sort,is_del) VALUES
        (1,'platform',0,0,1,0,0),(101,'other',2,30,1,0,0),(102,'store',1,20,1,0,0),
        (103,'retired',2,20,1,0,1);
      UPDATE shipping_templates SET type=2 WHERE id=201; UPDATE shipping_templates SET sort=9,type=3 WHERE id=202`);
    const issued = await createToken(27, 'supplier', md5(''), env.APP_KEY);
    bearer = issued.token; buckets.set(md5(bearer), { ...issued, uid: 27, type: 'supplier' });
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const request = async (path = optionsPath, token = bearer, method = 'GET') => {
    const response = await app.request(path, { method, headers: { Authorization: `Bearer ${token}`, 'X-Supplier-Id': '30' } }, env);
    return { response, body: await response.json() as { status: number; data: any; msg: string } };
  };
  it.each(['supplier.product.view', 'supplier.product.manage'])('%s reads all 125 options without shipping permission or rule-table grants', async rules => {
    await f.exec(`UPDATE system_role SET rules='${rules}' WHERE id=2`);
    const ids: number[] = [];
    for (let page = 1; page <= 7; page++) {
      const { body, response } = await request(`${optionsPath}?page=${page}&limit=20&supplierId=30&relation_id=30&owner_type=0`);
      expect(body.status).toBe(200); expect(body.data.count).toBe(125);
      expect(response.headers.get('cache-control')).toContain('no-store');
      for (const row of body.data.data) expect(Object.keys(row).sort()).toEqual(['id','name','type']);
      ids.push(...body.data.data.map((row: { id: number }) => row.id));
    }
    expect(ids).toEqual([202, ...Array.from({ length: 125 }, (_, i) => 325-i).filter(id => id !== 202)]);
    const summary = await request(`${optionsPath}/201`);
    expect(summary.body).toMatchObject({ status: 200, data: { id: 201, name: 'template-1', type: '按重量' } });
    expect(Object.keys(summary.body.data).sort()).toEqual(['id','name','type']);
  });
  it('searches the full owned set and retains the total on an empty page', async () => {
    expect((await request(`${optionsPath}?name=template-1&page=1&limit=100`)).body.data.count).toBe(37);
    expect((await request(`${optionsPath}?page=100&limit=20`)).body).toMatchObject({status:200,data:{count:125,data:[]}});
  });
  it.each([1,101,102,103,999999])('hides inaccessible/retired/missing exact ID %s identically', async id => {
    expect((await request(`${optionsPath}/${id}`)).body).toMatchObject({status:404,data:null,msg:'运费模板不存在或不属于当前供应商'});
  });
  it.each(['0','-1','1.5','2147483648','abc','1e2'])('rejects invalid exact ID %s', async id => {
    expect((await request(`${optionsPath}/${id}`)).body.status).toBe(400);
  });
  it.each(['limit=101','page=0','page=1.5',`name=${'a'.repeat(256)}`])('rejects invalid query %s', async query => {
    expect((await request(`${optionsPath}?${query}`)).body.status).toBe(400);
  });
  it('does not grant shipping management reads, writes or receipt recovery to product managers', async () => {
    for (const [path, method] of [
      ['/setting/shipping_templates/list','GET'], ['/setting/shipping_templates/201/edit','GET'],
      ['/setting/shipping_templates/save/0','POST'], ['/setting/shipping_templates/del/201','DELETE'],
      ['/setting/shipping_templates/creation-receipt','POST'],
    ]) expect((await request('/supplierapi'+path, bearer, method)).body.status).toBe(400011);
  });
  it.each(['supplier.shipping.manage','', 'supplier.finance.view'])('unrelated or missing product permission %s is denied', async rules => {
    await f.exec(`UPDATE system_role SET rules='${rules}' WHERE id=2`);
    for (const path of [optionsPath, `${optionsPath}/201`]) {
      const result = await request(path); expect(result.body.status).toBe(400011);
      expect(result.response.headers.get('cache-control')).toContain('no-store');
    }
  });
  it('revalidates role revocation and tenant reassignment using the same JWT', async () => {
    expect((await request()).body.status).toBe(200);
    await f.exec('UPDATE system_role SET status=0 WHERE id=2');
    expect((await request()).body.status).toBe(400011);
    await f.exec("UPDATE system_admin SET relation_id=30,roles='3' WHERE id=27");
    expect((await request()).body).toMatchObject({status:200,data:{count:1,data:[{id:101,name:'other'}]}});
    expect((await request(`${optionsPath}/201`)).body.status).toBe(404);
  });
  it('denies unauthenticated requests before lookup with private cache headers', async () => {
    for (const path of [optionsPath,`${optionsPath}/201`]) {
      const result = await request(path,''); expect(result.body.status).toBe(410000);
      expect(result.response.headers.get('cache-control')).toContain('no-store');
    }
  });
});
