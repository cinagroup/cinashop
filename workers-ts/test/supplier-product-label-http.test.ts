import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createToken, md5 } from '@/utils/jwt';
import { legacyCategory, storeProductLabel, storeProductLabelAuxiliary, storeProductRelation, storeProduct, systemAdmin, systemRole, systemLog } from '@/models/schema';
import { SupplierProductLabelService } from '@/services/supplier/SupplierProductLabelService';
import { supplierProductLabelFixture, seedSupplierLabels, supplierLabelBody, supplierLabelActor } from './helpers/supplierProductLabels';

const wiring = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: wiring.open }));
const env = { APP_KEY: 'owned-supplier-label-http', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const prefix = '/supplierapi/product', catalogPath = `${prefix}/label/catalog`;

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier label complete createApp routes with real JWT, role and SQL', () => {
  let f: Awaited<ReturnType<typeof supplierProductLabelFixture>>, tokens: Record<number, string>, service: SupplierProductLabelService;
  const app = createApp();
  beforeAll(async () => { f = await supplierProductLabelFixture(); wiring.open.mockImplementation(() => f.container); service = new SupplierProductLabelService(f.container); }, 60000);
  afterAll(async () => { await f?.close(); }, 30000);
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Supplier label tests forbid external I/O')); await f.reset(); await seedSupplierLabels(f.db);
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_label','id'),400,false)");
    tokens = {}; for (const id of [21, 22, 23, 29, 31, 39]) tokens[id] = (await createToken(id, 'supplier', md5('supplier-label-password'), env.APP_KEY)).token;
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  async function request(method: string, path: string, body?: unknown, id = 21) {
    const response = await app.request(path, { method, headers: { ...(id ? { Authorization: `Bearer ${tokens[id]}` } : {}), 'X-Supplier-Id': '30',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
    return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
  }
  const catalog = (id = 21) => request('GET', catalogPath, undefined, id);
  const save = (id = 0, body: unknown = supplierLabelBody(), actor = 21) => request('POST', `${prefix}/label/${id}`, body, actor);
  const logs = () => f.db.select().from(systemLog).orderBy(systemLog.id);
  function privateResponse(response: Response) { expect(response.headers.get('cache-control')).toContain('private, no-store'); expect(response.headers.get('pragma')).toBe('no-cache'); }

  it('returns the actual platform group dynamic form and repaired owner-only all-label projection', async () => {
    const form = await request('GET', `${prefix}/label/form`, undefined, 22); expect(form.body.status, form.body.msg).toBe(200); privateResponse(form.response);
    expect(form.body.data).toEqual({ title: '添加商品标签', method: 'POST', action: 'product/label/0', rules: [
      { type: 'select', field: 'label_cate', title: '标签分组', value: '', options: [{ label: '平台商品标签组', value: 10 }, { label: '隐藏平台组', value: 11 }] },
      { type: 'input', field: 'label_name', title: '标签名称', value: '', props: { maxlength: 20 } },
    ] });
    const all = await request('GET', `${prefix}/all_label`); expect(all.body.status).toBe(200); privateResponse(all.response);
    expect(all.body.data).toEqual([201, 202, 205, 204, 203].map(id => ({ id, label_name: id === 201 ? '旧平台组下的供应商标签' : id === 202 ? '原有展示事实' : id === 205 ? '挂私有owner的坏关联' : id === 204 ? '挂到外域的坏关联' : '未分类旧标签' })));
    expect(await logs()).toEqual([]);
  });
  it('creates via the legacy platform form and the actual selector immediately lists the Supplier-owned new label', async () => {
    const result = await save(); expect(result.body.status, result.body.msg).toBe(200); privateResponse(result.response);
    const [row] = await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.id, result.body.data.id));
    expect(row).toMatchObject({ type: 2, relationId: 20, labelCate: 10, labelName: '供应商新增标签', styleType: 1, status: 1, isShow: 1, sort: 0 });
    const selector = await request('GET', `${prefix}/product_label`); expect(selector.body.status).toBe(200);
    expect(selector.body.data.find((group: any) => group.id === 10).children.map((label: any) => label.id)).toEqual([201, result.body.data.id, 101]);
    expect(JSON.stringify(selector.body.data)).not.toContain('其他供应商'); expect((await logs())[0]).toMatchObject({ adminId: 21, merchantId: 20, method: 'POST', type: 'supplier_product_label' });
  });
  it('edits only name and group and preserves every presentation, hidden, disabled, sort and timestamp fact', async () => {
    const [before] = await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.id, 202));
    const result = await save(202, supplierLabelBody({ label_name: '只改旧名称和分组' })); expect(result.body.status, result.body.msg).toBe(200);
    expect((await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.id, 202)))[0]).toEqual({ ...before, labelCate: 10, labelName: '只改旧名称和分组' });
    expect((await logs())[0].method).toBe('POST');
  });
  it('isolates current catalog from platform and foreign labels while exposing own orphan facts for deliberate cleanup', async () => {
    const result = await catalog(22); expect(result.body.status).toBe(200); privateResponse(result.response);
    expect(result.body.data.list.map((label: any) => label.id)).toEqual([201, 202, 205, 204, 203]);
    expect(result.body.data.list.find((label: any) => label.id === 203)).toMatchObject({ group_valid: false, selectable: false, label_cate: 0 });
    expect(result.body.data.groups.map((group: any) => group.id)).toEqual([10, 20, 11]);
    const other = await catalog(31); expect(other.body.data.list.map((label: any) => label.id)).toEqual([302, 301]);
    expect(JSON.stringify(result.body.data)).not.toContain('其他供应商');
  });
  it('rejects platform, foreign, user and parameter groups and owner-forgery without writes', async () => {
    for (const group of [12, 30, 40, 50, 70, 999]) expect((await save(0, supplierLabelBody({ label_cate: group }))).body.status).not.toBe(200);
    for (const row of [{ type: 0 }, { relation_id: 30 }, { supplierId: 30 }, { icon: '/api/assets/1' }, { status: 1 }]) expect((await save(0, supplierLabelBody(row))).body.status).toBe(400);
    for (const id of [101, 301, 999]) { expect((await save(id)).body.status).not.toBe(200); expect((await request('DELETE', `${prefix}/label/${id}`)).body.status).not.toBe(200); }
    expect(await logs()).toEqual([]);
  });
  it('rejects empty, oversized, malformed and duplicate group/name inputs with no partial effects', async () => {
    for (const body of [supplierLabelBody({ label_name: ' ' }), supplierLabelBody({ label_name: 'x'.repeat(21) }), supplierLabelBody({ label_cate: 0 }),
      supplierLabelBody({ label_cate: [] }), supplierLabelBody({ label_name: 'bad\u0000name' }), supplierLabelBody({ label_name: '旧平台组下的供应商标签' })]) expect((await save(0, body)).body.status).toBe(400);
    expect((await save(201, supplierLabelBody({ label_name: '旧平台组下的供应商标签' }))).body.status).toBe(200);
    const before = (await logs()).length; expect((await request('POST', `${prefix}/label/0?relation_id=30`, supplierLabelBody())).body.status).toBe(400);
    expect((await request('GET', `${prefix}/label/form?type=2`)).body.status).toBe(400); expect((await logs()).length).toBe(before);
  });
  it('keeps view and numeric GET form grants read-only, with private anonymous and reader write failures', async () => {
    for (const actor of [22, 23]) {
      expect((await request('GET', `${prefix}/label/form`, undefined, actor)).body.status).toBe(200);
      const denied = await save(0, supplierLabelBody(), actor); expect(denied.body.status).toBe(400011); privateResponse(denied.response);
    }
    for (const [method, path] of [['GET', catalogPath], ['GET', `${prefix}/all_label`], ['GET', `${prefix}/label/form`], ['POST', `${prefix}/label/0`], ['DELETE', `${prefix}/label/203`]]) {
      const result = await request(method, path, method === 'POST' ? supplierLabelBody() : undefined, 0); expect(result.body.status).toBe(410000); privateResponse(result.response);
    }
    expect(await logs()).toEqual([]);
  });
  it('deletes an unreferenced owner label without a request body and refuses every real reference representation', async () => {
    expect((await request('DELETE', `${prefix}/label/203`)).body).toMatchObject({ status: 200, data: null });
    for (const representation of ['relation', 'auxiliary', 'csv'] as const) {
      if (representation === 'relation') await f.db.insert(storeProductRelation).values({ productId: 90, type: 3, relationId: 201, status: 0 });
      if (representation === 'auxiliary') await f.db.insert(storeProductLabelAuxiliary).values({ productId: 90, labelId: 201 });
      if (representation === 'csv') await f.db.update(storeProduct).set({ storeLabelId: ' +000201 , 999 ' }).where(eq(storeProduct.id, 90));
      expect((await request('DELETE', `${prefix}/label/201`)).body.status).toBe(400);
      await f.db.delete(storeProductRelation); await f.db.delete(storeProductLabelAuxiliary); await f.db.update(storeProduct).set({ storeLabelId: '' });
    }
    expect((await logs()).map(row => row.method)).toEqual(['DELETE']);
  });
  it('protects malformed historical CSV conservatively and does not drop disabled or foreign historical reference facts', async () => {
    await f.db.update(storeProduct).set({ storeLabelId: 'bad-token' }).where(eq(storeProduct.id, 90));
    expect((await request('DELETE', `${prefix}/label/201`)).body.status).toBe(400); expect(await logs()).toEqual([]);
  });
  it('rejects stale revisions and permits intentional refresh for create, edit and delete', async () => {
    const initial = (await catalog()).body.data; await save(0, supplierLabelBody({ label_name: '改变目录' }));
    expect((await save(0, supplierLabelBody({ expected_revision: initial.revision }))).body.status).toBe(409);
    const row = initial.list.find((label: any) => label.id === 201); await save(201, supplierLabelBody({ label_name: '真实更新' }));
    expect((await save(201, supplierLabelBody({ expected_revision: row.revision }))).body.status).toBe(409);
    expect((await request('DELETE', `${prefix}/label/201`, { expected_revision: row.revision })).body.status).toBe(409);
    const refreshed = (await catalog()).body.data.list.find((label: any) => label.id === 201);
    expect((await request('DELETE', `${prefix}/label/201`, { expected_revision: refreshed.revision })).body.status).toBe(200);
  });
  it('rechecks real password claims, expiry and roles within the label transaction', async () => {
    await f.db.update(systemAdmin).set({ pwd: 'rotated' }).where(eq(systemAdmin.id, 21));
    await expect(service.save(20, 0, supplierLabelBody(), supplierLabelActor())).rejects.toMatchObject({ code: 410001 });
    await expect(service.save(20, 0, supplierLabelBody(), { ...supplierLabelActor(), authVersion: md5('rotated'), expiresAt: 1 })).rejects.toMatchObject({ code: 410001 });
    await f.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 21));
    await expect(service.save(20, 0, supplierLabelBody(), { ...supplierLabelActor(), authVersion: md5('rotated') })).rejects.toMatchObject({ code: 400011 }); expect(await logs()).toEqual([]);
  });
  it('rolls back dropped audit receipts and label triggers rewriting unselected display facts', async () => {
    const before = await f.db.select().from(storeProductLabel).orderBy(storeProductLabel.id);
    await f.exec("CREATE FUNCTION skip_supplier_label_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER skip_supplier_label_audit BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION skip_supplier_label_audit()");
    try { expect((await save()).body.status).not.toBe(200); expect(await f.db.select().from(storeProductLabel).orderBy(storeProductLabel.id)).toEqual(before); expect(await logs()).toEqual([]); }
    finally { await f.exec('DROP TRIGGER skip_supplier_label_audit ON system_log; DROP FUNCTION skip_supplier_label_audit()'); }
    await f.exec("CREATE FUNCTION mutate_supplier_label_style() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.status=1; NEW.icon='rewritten'; RETURN NEW; END $$; CREATE TRIGGER mutate_supplier_label_style BEFORE UPDATE ON store_product_label FOR EACH ROW EXECUTE FUNCTION mutate_supplier_label_style()");
    try { expect((await save(202)).body.status).not.toBe(200); expect(await f.db.select().from(storeProductLabel).orderBy(storeProductLabel.id)).toEqual(before); expect(await logs()).toEqual([]); }
    finally { await f.exec('DROP TRIGGER mutate_supplier_label_style ON store_product_label; DROP FUNCTION mutate_supplier_label_style()'); }
  });
  it('rechecks label facts after a valid audit trigger changes them and rolls back both rows', async () => {
    await f.exec("CREATE FUNCTION audit_supplier_label_mutation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN UPDATE store_product_label SET sort=99 WHERE id=201; RETURN NEW; END $$; REVOKE ALL ON FUNCTION audit_supplier_label_mutation() FROM PUBLIC; CREATE TRIGGER audit_supplier_label_mutation BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION audit_supplier_label_mutation()");
    try { expect((await save(201)).body.status).not.toBe(200); expect((await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.id, 201)))[0]).toMatchObject({ labelName: '旧平台组下的供应商标签', sort: 10 }); expect(await logs()).toEqual([]); }
    finally { await f.exec('DROP TRIGGER audit_supplier_label_mutation ON system_log; DROP FUNCTION audit_supplier_label_mutation()'); }
  });
  it('rejects bounded label and group overflow explicitly instead of silently truncating the management or form view', async () => {
    await f.db.insert(storeProductLabel).values(Array.from({ length: 1996 }, (_, i) => ({ id: 1000 + i, type: 2, relationId: 20, labelCate: 10, labelName: `label-${i}` })));
    expect((await catalog()).body.status).not.toBe(200); expect((await request('GET', `${prefix}/all_label`)).body.status).not.toBe(200);
    await f.db.delete(storeProductLabel).where(eq(storeProductLabel.type, 2));
    await f.db.insert(legacyCategory).values(Array.from({ length: 1000 }, (_, i) => ({ id: 1000 + i, type: 0, relationId: 0, group: 2, name: `group-${i}` })));
    expect((await request('GET', `${prefix}/label/form`)).body.status).not.toBe(200);
  });
});
