import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createToken, md5 } from '@/utils/jwt';
import { storeProductRule, storeProduct, storeProductAttr, storeProductAttrValue, systemAdmin, systemRole, systemLog } from '@/models/schema';
import { SupplierProductRuleService } from '@/services/supplier/SupplierProductRuleService';
import { supplierProductRuleFixture, seedSupplierRules, supplierRuleBody, supplierRuleActor } from './helpers/supplierProductRules';
const wiring = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: wiring.open }));
const env = { APP_KEY: 'owned-fifth-supplier-rule-http', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const prefix = '/supplierapi/product/product', path = `${prefix}/rule`;
describe('Supplier rule five complete registered createApp contracts, actual JWT and SQL', () => {
  let f: Awaited<ReturnType<typeof supplierProductRuleFixture>>, tokens: Record<number, string>, service: SupplierProductRuleService;
  const app = createApp();
  beforeAll(async () => { f = await supplierProductRuleFixture(); wiring.open.mockImplementation(() => f.container); service = new SupplierProductRuleService(f.container); }, 60000);
  afterAll(async () => { await f?.close(); }, 30000);
  beforeEach(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Supplier rule tests forbid external I/O')); await f.reset(); await seedSupplierRules(f.db);
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_rule','id'),400,false)"); tokens = {};
    for (const id of [21, 22, 23, 24, 29, 31, 39]) tokens[id] = (await createToken(id, 'supplier', md5('supplier-rule-password'), env.APP_KEY)).token;
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  async function request(method: string, url: string, body?: unknown, actor = 21) {
    const response = await app.request(url, { method, headers: { ...(actor ? { Authorization: `Bearer ${tokens[actor]}` } : {}), 'X-Supplier-Id': '30',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
    return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
  }
  const save = (id = 0, body: unknown = supplierRuleBody(), actor = 21) => request('POST', `${path}/${id}`, body, actor);
  const logs = () => f.db.select().from(systemLog).orderBy(systemLog.id);
  const rows = () => f.db.select().from(storeProductRule).orderBy(storeProductRule.id);
  function privateResponse(response: Response) { expect(response.headers.get('cache-control')).toContain('private, no-store'); expect(response.headers.get('pragma')).toBe('no-cache'); }
  it('retains legacy raw list/detail and decoded get_rule DTOs with own type/relation and ID descending', async () => {
    const list = await request('GET', path, undefined, 22); expect(list.body.status, list.body.msg).toBe(200); privateResponse(list.response);
    expect(list.body.data).toMatchObject({ count: 2, page: 0, limit: 0 }); expect(list.body.data.list.map((row: any) => row.id)).toEqual([202, 201]);
    const row = list.body.data.list[1]; expect(row).toMatchObject({ type: 2, relation_id: 20, rule_name: '当前服装模板', rule_value: JSON.stringify(supplierRuleBody().spec), attr_name: '颜色,尺码', attr_value: ['红,蓝', 'S,M'], spec: supplierRuleBody().spec });
    expect(row.revision).toMatch(/^[a-f0-9]{64}$/); expect((await request('GET', `${path}/201`)).body.data).toEqual({ info: row });
    const all = await request('GET', `${prefix}/get_rule`); expect(all.body.status).toBe(200); privateResponse(all.response);
    expect(all.body.data[1]).toEqual({ ...row, rule_value: supplierRuleBody().spec }); expect(await logs()).toEqual([]);
  });
  it('returns all canonical no-page rows rather than silently limiting to twenty and paginates explicit modern queries', async () => {
    await f.db.insert(storeProductRule).values(Array.from({ length: 25 }, (_, i) => ({ id: 500 + i, type: 2, relationId: 20, ruleName: `paged-${i}`, ruleValue: '[]' })));
    const all = await request('GET', path); expect(all.body.data.list).toHaveLength(27); expect(all.body.data.count).toBe(27);
    const page = await request('GET', `${path}?page=2&limit=20`); expect(page.body.data).toMatchObject({ count: 27, page: 2, limit: 20 }); expect(page.body.data.list).toHaveLength(7);
    const search = await request('GET', `${path}?rule_name=paged-&page=1&limit=10`); expect(search.body.data.count).toBe(25); expect(search.body.data.list).toHaveLength(10);
    expect((await request('GET', `${path}?rule_name=%25`)).body.data.count).toBe(27);
  });
  it('creates, rereads, accepts full legacy info editing projection and deletes without a body with atomic exact audit methods', async () => {
    const created = await save(); expect(created.body.status, created.body.msg).toBe(200); privateResponse(created.response);
    const detail = (await request('GET', `${path}/${created.body.data.id}`)).body.data.info;
    expect(detail.revision).toBe(created.body.data.revision);
    const edited = await save(detail.id, { ...detail, rule_name: '编辑完整旧DTO', type: 0, relation_id: 30 }); expect(edited.body.status, edited.body.msg).toBe(200);
    expect((await rows()).find(row => row.id === detail.id)).toMatchObject({ type: 2, relationId: 20, ruleName: '编辑完整旧DTO' });
    const removed = await request('DELETE', `${path}/delete/${detail.id}`); expect(removed.body).toMatchObject({ status: 200, data: null }); privateResponse(removed.response);
    expect((await logs()).map(row => [row.adminId, row.merchantId, row.type, row.method, row.path])).toEqual([
      [21, 20, 'supplier_product_rule', 'POST', `${path}/0`], [21, 20, 'supplier_product_rule', 'POST', `${path}/${detail.id}`], [21, 20, 'supplier_product_rule', 'DELETE', `${path}/delete/${detail.id}`]]);
  });
  it('saves and searches real JWT-owned Unicode code-point boundaries and rejects oversize or invalid characters without SQL or audit changes', async () => {
    const name = '😀'.repeat(32), dimension = '🚀'.repeat(32), value = '🍀'.repeat(64);
    const spec = [{ value: dimension, detail: [value] }];
    const created = await save(0, supplierRuleBody({ rule_name: ` ${name} `, spec }));
    expect(created.body.status, created.body.msg).toBe(200); privateResponse(created.response);
    const id = created.body.data.id;
    const detail = (await request('GET', `${path}/${id}`)).body.data.info;
    expect(detail).toMatchObject({ id, type: 2, relation_id: 20, rule_name: name, rule_value: JSON.stringify(spec), spec });
    expect((await rows()).find(row => row.id === id)).toMatchObject({ type: 2, relationId: 20, ruleName: name, ruleValue: JSON.stringify(spec) });
    const searched = await request('GET', `${path}?rule_name=${encodeURIComponent(name)}&page=1&limit=20`);
    expect(searched.body.status, searched.body.msg).toBe(200);
    expect(searched.body.data.count).toBe(1); expect(searched.body.data.list.map((row: any) => row.id)).toEqual([id]);
    const maximumQuery = await request('GET', `${path}?rule_name=${encodeURIComponent('😀'.repeat(50))}`);
    expect(maximumQuery.body.status, maximumQuery.body.msg).toBe(200); expect(maximumQuery.body.data.count).toBe(0);
    const beforeRows = await rows(), beforeLogs = await logs();
    expect(beforeLogs).toHaveLength(1);
    expect(beforeLogs[0]).toMatchObject({ adminId: 21, merchantId: 20, type: 'supplier_product_rule', method: 'POST', path: `${path}/0` });
    const invalid = [supplierRuleBody({ rule_name: '😀'.repeat(33), spec }),
      supplierRuleBody({ rule_name: '超长维度拒绝', spec: [{ value: '🚀'.repeat(33), detail: [value] }] }),
      supplierRuleBody({ rule_name: '超长规格值拒绝', spec: [{ value: dimension, detail: ['🍀'.repeat(65)] }] })];
    for (const character of ['\u0001', '\u007f', '\u0085', '\u009f', '\ud800', '\udfff']) {
      invalid.push(supplierRuleBody({ rule_name: `x${character}y` }),
        supplierRuleBody({ spec: [{ value: `x${character}y`, detail: ['有效值'] }] }),
        supplierRuleBody({ spec: [{ value: '有效维度', detail: [`x${character}y`] }] }));
    }
    for (const body of invalid) {
      expect((await save(0, body)).body.status).toBe(400);
      expect(await rows()).toEqual(beforeRows); expect(await logs()).toEqual(beforeLogs);
    }
    // URL query decoding cannot preserve isolated surrogates. JSON above can;
    // query boundaries and control characters are tested through actual URLs.
    for (const search of ['😀'.repeat(51), 'x\u0001y', 'x\u007fy', 'x\u0085y', 'x\u009fy']) {
      expect((await request('GET', `${path}?rule_name=${encodeURIComponent(search)}`)).body.status).toBe(400);
      expect(await rows()).toEqual(beforeRows); expect(await logs()).toEqual(beforeLogs);
    }
  });
  it('deletes a copied template without changing the existing product, dimension or priced stock SKU', async () => {
    const before = [await f.db.select().from(storeProduct), await f.db.select().from(storeProductAttr), await f.db.select().from(storeProductAttrValue)];
    expect((await request('DELETE', `${path}/delete/202`, { ids: '' })).body.status).toBe(200);
    expect([await f.db.select().from(storeProduct), await f.db.select().from(storeProductAttr), await f.db.select().from(storeProductAttrValue)]).toEqual(before);
  });
  it('keeps platform/foreign IDs absent and supplier header forgery unable to change the real owner', async () => {
    for (const id of [101, 301, 999]) { expect((await request('GET', `${path}/${id}`)).body.status).toBe(404);
      expect((await save(id)).body.status).toBe(404); expect((await request('DELETE', `${path}/delete/${id}`)).body.status).toBe(404); }
    const other = await request('GET', path, undefined, 31); expect(other.body.data.list.map((row: any) => row.id)).toEqual([301]); expect(await logs()).toEqual([]);
  });
  it('keeps view and numeric GET grants read-only with private pre-auth failures for all five routes', async () => {
    for (const actor of [22, 23]) { expect((await request('GET', path, undefined, actor)).body.status).toBe(200);
      const denied = await save(0, supplierRuleBody(), actor); expect(denied.body.status).toBe(400011); privateResponse(denied.response); }
    for (const [method, url] of [['GET', path], ['GET', `${path}/201`], ['GET', `${prefix}/get_rule`], ['POST', `${path}/0`], ['DELETE', `${path}/delete/201`]]) {
      const result = await request(method, url, method === 'POST' ? supplierRuleBody() : undefined, 0); expect(result.body.status).toBe(410000); privateResponse(result.response);
    }
    expect((await save(0, supplierRuleBody(), 24)).body.status).toBe(200);
  });
  it('rejects malformed and oversized rules, ambiguous fields and query/ID boundaries without writes', async () => {
    const invalid = [supplierRuleBody({ rule_name: ' ' }), supplierRuleBody({ rule_name: 'x'.repeat(33) }), supplierRuleBody({ rule_name: 'bad\u0000name' }),
      supplierRuleBody({ ruleName: 'different' }), supplierRuleBody({ ownerId: 30 }), supplierRuleBody({ spec: [] }), supplierRuleBody({ spec: Array.from({ length: 4 }, (_, i) => ({ value: `${i}`, detail: ['x'] })) }),
      supplierRuleBody({ spec: [{ value: 'x', detail: ['a', 'a'] }] }), supplierRuleBody({ spec: [{ value: 'x', detail: Array.from({ length: 51 }, (_, i) => `${i}`) }] }), supplierRuleBody({ expected_revision: 'bad' })];
    for (const body of invalid) expect((await save(0, body)).body.status).toBe(400);
    for (const url of [`${path}?page=0`, `${path}?limit=101`, `${path}?page=1&page=2`, `${path}?ownerId=30`, `${path}/201?relation_id=30`, `${prefix}/get_rule?type=0`]) expect((await request('GET', url)).body.status).toBe(400);
    expect((await save(2147483648)).body.status).toBe(400);
    const zeroDelete = await request('DELETE', `${path}/delete/0`); expect(zeroDelete.body.status).toBe(400011); privateResponse(zeroDelete.response); expect(await logs()).toEqual([]);
  });
  it('allows independent owner duplicate names but refuses duplicates within the exact owner scope', async () => {
    expect((await save(0, supplierRuleBody({ rule_name: '当前服装模板' }))).body.status).toBe(400);
    expect((await save(0, supplierRuleBody({ rule_name: '平台模板' }))).body.status).toBe(200);
    expect((await save(0, supplierRuleBody({ rule_name: '当前服装模板' }), 31)).body.status).toBe(200);
  });
  it('checks catalog create revision and exact edit/delete row revisions without requiring new fields from legacy clients', async () => {
    const initial = (await request('GET', path)).body.data; await save();
    expect((await save(0, supplierRuleBody({ rule_name: 'stale-create', expected_revision: initial.revision }))).body.status).toBe(409);
    const row = initial.list.find((row: any) => row.id === 201); expect((await save(201, supplierRuleBody({ rule_name: 'changed-rule' }))).body.status).toBe(200);
    expect((await save(201, supplierRuleBody({ expected_revision: row.revision }))).body.status).toBe(409);
    expect((await request('DELETE', `${path}/delete/201`, { expected_revision: row.revision })).body.status).toBe(409);
    const fresh = (await request('GET', `${path}/201`)).body.data.info;
    expect((await request('DELETE', `${path}/delete/201`, { expected_revision: fresh.revision })).body.status).toBe(200);
  });
  it('rechecks password expiry and current roles in the service transaction rather than relying on middleware claims', async () => {
    await f.db.update(systemAdmin).set({ pwd: 'rotated' }).where(eq(systemAdmin.id, 21));
    await expect(service.save(20, 0, supplierRuleBody(), supplierRuleActor())).rejects.toMatchObject({ code: 410001 });
    await expect(service.list(20, new URLSearchParams(), supplierRuleActor())).rejects.toMatchObject({ code: 410001 });
    await expect(service.save(20, 0, supplierRuleBody(), { ...supplierRuleActor(), authVersion: md5('rotated'), expiresAt: 1 })).rejects.toMatchObject({ code: 410001 });
    await f.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 21));
    await expect(service.save(20, 0, supplierRuleBody(), { ...supplierRuleActor(), authVersion: md5('rotated') })).rejects.toMatchObject({ code: 400011 }); expect(await logs()).toEqual([]);
  });
  it.each(['UPDATE', 'DELETE'])('rolls back actual BEFORE %s suppression instead of reporting success with no row receipt', async operation => {
    const before = await rows(); await f.exec(`CREATE FUNCTION suppress_rule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER suppress_rule BEFORE ${operation} ON store_product_rule FOR EACH ROW EXECUTE FUNCTION suppress_rule()`);
    try { const result = operation === 'UPDATE' ? await save(201) : await request('DELETE', `${path}/delete/201`); expect(result.body.status).not.toBe(200); expect(await rows()).toEqual(before); expect(await logs()).toEqual([]); }
    finally { await f.exec('DROP TRIGGER suppress_rule ON store_product_rule; DROP FUNCTION suppress_rule()'); }
  });
  it('rejects every rewritten rule fact and an audit trigger changing another owner rule with complete rollback', async () => {
    const before = await rows(); await f.exec("CREATE FUNCTION rewrite_rule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.type=0; NEW.relation_id=0; RETURN NEW; END $$; CREATE TRIGGER rewrite_rule BEFORE UPDATE ON store_product_rule FOR EACH ROW EXECUTE FUNCTION rewrite_rule()");
    try { expect((await save(201)).body.status).not.toBe(200); expect(await rows()).toEqual(before); expect(await logs()).toEqual([]); }
    finally { await f.exec('DROP TRIGGER rewrite_rule ON store_product_rule; DROP FUNCTION rewrite_rule()'); }
    await f.exec("CREATE FUNCTION audit_rewrite_rule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_product_rule SET rule_name='unexpected' WHERE id=202; RETURN NEW; END $$; CREATE TRIGGER audit_rewrite_rule BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION audit_rewrite_rule()");
    try { expect((await save(201)).body.status).not.toBe(200); expect(await rows()).toEqual(before); expect(await logs()).toEqual([]); }
    finally { await f.exec('DROP TRIGGER audit_rewrite_rule ON system_log; DROP FUNCTION audit_rewrite_rule()'); }
  });
  it('rolls back both creates and deletes when the actual audit insert is suppressed or its receipt fields are changed', async () => {
    const before = await rows(); await f.exec("CREATE FUNCTION skip_rule_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER skip_rule_audit BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION skip_rule_audit()");
    try { expect((await save()).body.status).not.toBe(200); expect((await request('DELETE', `${path}/delete/201`)).body.status).not.toBe(200); expect(await rows()).toEqual(before); expect(await logs()).toEqual([]); }
    finally { await f.exec('DROP TRIGGER skip_rule_audit ON system_log; DROP FUNCTION skip_rule_audit()'); }
    await f.exec("CREATE FUNCTION corrupt_rule_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.admin_id=29; RETURN NEW; END $$; CREATE TRIGGER corrupt_rule_audit BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION corrupt_rule_audit()");
    try { expect((await save()).body.status).not.toBe(200); expect(await rows()).toEqual(before); expect(await logs()).toEqual([]); }
    finally { await f.exec('DROP TRIGGER corrupt_rule_audit ON system_log; DROP FUNCTION corrupt_rule_audit()'); }
  });
  it('explicitly rejects full-list and get_rule overflow rather than truncating legacy selection', async () => {
    await f.db.insert(storeProductRule).values(Array.from({ length: 999 }, (_, i) => ({ id: 500 + i, type: 2, relationId: 20, ruleName: `bound-${i}`, ruleValue: '[]' })));
    for (const url of [path, `${path}?page=1&limit=20`, `${prefix}/get_rule`]) expect((await request('GET', url)).body.status).not.toBe(200);
    expect((await save()).body.status).not.toBe(200); expect(await logs()).toEqual([]);
  });
});
