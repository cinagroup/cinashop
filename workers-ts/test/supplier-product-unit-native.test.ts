import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { storeProduct, storeProductAttrValue, storeProductUnit } from '@/models/schema';
import { SUPPLIER_COPY_FIELDS } from '@/services/supplier/SupplierProductCopySource';
import { supplierProductUnitsFixture, supplierUnitExpectedDirectory } from './helpers/supplierProductUnits';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined, moderator: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned unit HTTP LOGIN'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.moderator) throw Error('Missing owned unit reviewer LOGIN'); return { container: wiring.moderator, close: async () => {} }; },
}));
type Envelope = { status: number; msg: string; data: any };
const app = createApp();

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier unit text directory and actual ordinary publication on owned PG16', () => {
  let f: Awaited<ReturnType<typeof supplierProductUnitsFixture>>;
  beforeEach(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned unit scenario forbids outbound I/O')); f = await supplierProductUnitsFixture(); wiring.container = f.container; }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { await f?.close(); wiring.container = undefined; wiring.moderator = undefined; vi.restoreAllMocks(); } }, 30000);
  async function request(method: string, path: string, body?: unknown, actor: keyof typeof f.tokens | 'anonymous' = 'manager') {
    const response = await app.request('/supplierapi' + path, { method, headers: {
      ...(actor === 'anonymous' ? {} : { Authorization: 'Bearer ' + f.tokens[actor] }), 'X-Supplier-Id': '8',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, f.env);
    expect(response.headers.get('cache-control')).toContain('private, no-store'); return response.json<Envelope>();
  }
  async function unchanged(work: () => Promise<unknown>) { const before = await f.snapshot(), seq = await f.sequences(); await work(); expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(seq); }
  async function preserved(before: Awaited<ReturnType<typeof f.snapshot>>, unit: string, id = 80) {
    const current = await f.snapshot(), old = before.store_product.find(item => item.row.id === id)!.row;
    expect(current.store_product.find(item => item.row.id === id)!.row).toEqual({ ...old, unit_name: unit, is_show: 0, is_verify: 0 });
    const regenerated = new Set(['store_product', 'store_product_attr', 'store_product_attr_result', 'store_product_relation']);
    for (const name of Object.keys(before)) if (!regenerated.has(name)) expect(current[name], name).toEqual(before[name]);
    expect(current.store_product.filter(item => item.row.id !== id)).toEqual(before.store_product.filter(item => item.row.id !== id));
    expect(current.store_product_relation.filter(item => item.row.product_id === id && item.row.type !== 1))
      .toEqual(before.store_product_relation.filter(item => item.row.product_id === id && item.row.type !== 1));
  }

  it('returns only enabled undeleted platform and current Supplier units in stable sort/id order through a SELECT-only viewer and performs zero writes', async () => f.withReader(async runtime => {
    wiring.container = runtime.container;
    await unchanged(async () => {
      const result = await request('GET', '/product/get_all_unit', undefined, 'viewer'); expect(result.status, result.msg).toBe(200); expect(result.data).toEqual(supplierUnitExpectedDirectory);
      expect(JSON.stringify(result.data)).not.toMatch(/外店桶|停用单位|删除单位|错配平台|门店单位/);
      const other = await request('GET', '/product/get_all_unit?supplier_id=7', undefined, 'other'); expect(other.status, other.msg).toBe(200);
      expect(other.data.map((row: { id: number }) => row.id)).toEqual([205, 202, 201, 210]);
    });
    const [rights] = await runtime.db.execute(sql`SELECT current_user=session_user AS independent,
      has_table_privilege(current_user,'store_product_unit','SELECT') AS directory_read,
      has_table_privilege(current_user,'store_product_unit','INSERT,UPDATE,DELETE') AS directory_write,
      has_any_column_privilege(current_user,'store_product','UPDATE') AS product_write,
      has_table_privilege(current_user,'store_order','SELECT,INSERT,UPDATE,DELETE') AS order_access,
      has_table_privilege(current_user,'system_form_data','SELECT,INSERT,UPDATE,DELETE') AS answers_access`);
    expect(rights).toEqual({ independent: true, directory_read: true, directory_write: false, product_write: false, order_access: false, answers_access: false });
  }));

  it.each(['anonymous', 'denied'] as const)('refuses directory access by %s without SQL writes', async actor => f.withReader(async runtime => {
    wiring.container = runtime.container; await unchanged(async () => expect((await request('GET', '/product/get_all_unit', undefined, actor)).status).not.toBe(200));
  }));

  it.each([0, 1, 3])('round-trips directory text and the mature empty-to-件 fallback for ordinary fulfillment type %i without changing SKU inventory or history', async type => {
    const id = type === 1 ? 81 : 80;
    // Inherited controls began as physical products. Align only this owned
    // seed with mature nonphysical shipping BEFORE the invariant baseline;
    // keep the whole-row equality and every inventory/history check below.
    if (type !== 0) await f.db.update(storeProduct).set({ productType: type, deliveryType: '', freight: 2 }).where(eq(storeProduct.id, id));
    if (type === 3) await f.db.update(storeProductAttrValue).set({ productType: 3 }).where(eq(storeProductAttrValue.productId, id));
    await f.withWriter(async runtime => {
      wiring.container = runtime.container;
      for (const [input, expected] of [['箱', '箱'], ['', '件']] as const) {
        const before = await f.snapshot(), saved = await request('POST', '/product/product/' + id, await f.body({ unit_name: input }, id));
        expect(saved.status, saved.msg).toBe(200); await preserved(before, expected, id);
        await unchanged(async () => { const detail = await request('GET', '/product/product/' + id); expect(detail.status, detail.msg).toBe(200); expect(detail.data.unit_name).toBe(expected); });
      }
    });
  });

  it('keeps free historical text independent of catalog changes and accepts the exact 32-character author boundary', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container;
    for (const name of ['历史自由单位', '量'.repeat(32)]) {
      await f.db.update(storeProductUnit).set({ isDel: 1 });
      const before = await f.snapshot(), result = await request('POST', '/product/product/80', await f.body({ unit_name: name }));
      expect(result.status, result.msg).toBe(200); await preserved(before, name);
      expect((await request('GET', '/product/product/80')).data.unit_name).toBe(name);
      expect((await request('GET', '/product/get_all_unit')).data).toEqual([]);
    }
  }));

  it.each([undefined, null, '  '])('retains the mature full-save empty normalization for %j rather than introducing an optional unit intent protocol', async unit => f.withWriter(async runtime => {
    wiring.container = runtime.container; await f.db.update(storeProduct).set({ unitName: '旧自由单位' }).where(eq(storeProduct.id, 80));
    const before = await f.snapshot(), result = await request('POST', '/product/product/80', await f.body({ unit_name: unit }));
    expect(result.status, result.msg).toBe(200); await preserved(before, '件');
  }));

  it.each([{ value: '量'.repeat(33) }, { value: 0 }, { value: false }, { value: [] }])('rejects invalid unit text $value before any row or sequence write', async ({ value }) => f.withWriter(async runtime => {
    wiring.container = runtime.container; const body = await f.body({ unit_name: value });
    await unchanged(async () => expect((await request('POST', '/product/product/80', body)).status).toBe(400));
  }));

  it.each(['viewer', 'denied', 'other'] as const)('refuses %s product authoring without changing units inventory answers or sequences', async actor => f.withWriter(async runtime => {
    wiring.container = runtime.container; const body = await f.body({ unit_name: '箱' });
    await unchanged(async () => expect((await request('POST', '/product/product/80', body, actor)).status).not.toBe(200));
  }));

  it('retains editable unit_name in the existing safe copy UUID HMAC receipt and leaves all source SKUs history and catalog rows unchanged', async () => f.withCopyWriter(async runtime => {
    wiring.container = runtime.container; expect(SUPPLIER_COPY_FIELDS).toContain('unit_name');
    const before = await f.snapshot(), source = await f.product(), seed = await request('GET', '/product/product/copy/80'); expect(seed.status, seed.msg).toBe(200);
    const body = { operation_id: crypto.randomUUID(), copy_token: seed.data.copy.token, product: { ...Object.fromEntries(SUPPLIER_COPY_FIELDS.map(field => [field, seed.data.product[field]])), unit_name: '复制箱' } };
    const copied = await request('POST', '/product/product/copy/80', body); expect(copied.status, copied.msg).toBe(200); expect(copied.data.state).toBe('committed');
    const id = copied.data.result.id; expect((await f.product(id)).unitName).toBe('复制箱'); expect((await request('GET', '/product/product/' + id)).data.unit_name).toBe('复制箱');
    expect((await request('GET', '/product/product/copy_operations/' + body.operation_id)).data).toEqual(copied.data);
    expect(await f.product()).toEqual(source);
    const after = await f.snapshot(); for (const table of ['store_product_unit', 'store_order', 'store_order_cart_info', 'system_form_data']) expect(after[table]).toEqual(before[table]);
    expect(after.store_product_attr_value.filter(item => item.row.product_id === 80)).toEqual(before.store_product_attr_value.filter(item => item.row.product_id === 80));
  }), 60000);

  it('publishes the saved Supplier unit only after an independent real Admin review and projects it to real public catalog and detail with strictly scoped visit analytics', async () => {
    const baseline = await f.snapshot();
    await f.withWriter(async runtime => { wiring.container = runtime.container; const saved = await request('POST', '/product/product/80', await f.body({ unit_name: '箱' })); expect(saved.status, saved.msg).toBe(200); });
    await f.withDetailReader(async reader => f.withModerator(async moderator => {
      wiring.container = reader.container; wiring.moderator = moderator.container;
      const catalogue = async () => { const response = await app.request('/api/products?ids=80', {}, f.env); return response.json<Envelope>(); };
      await unchanged(async () => expect((await catalogue()).data.list).toEqual([]));
      const review = await app.request('/adminapi/product/product/set_verify/80', { method: 'POST', headers: { Authorization: 'Bearer ' + f.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ is_verify: 1, is_show: 1, refusal: '', auto_on_time: '' }) }, f.env);
      const reviewed = await review.json<Envelope>(); expect(reviewed.status, reviewed.msg).toBe(200);
      await unchanged(async () => { const list = await catalogue(); expect(list.status, list.msg).toBe(200); expect(list.data.list).toHaveLength(1); expect(list.data.list[0]).toMatchObject({ id: 80, unit_name: '箱' }); });
      const before = await f.snapshot(), pending: Promise<unknown>[] = [];
      const ctx: NonNullable<Parameters<typeof app.request>[3]> = { waitUntil: task => { pending.push(task); }, passThroughOnException() {}, props: {} };
      const response = await app.request('/api/product/detail/80', {}, f.env, ctx), detail = await response.json<Envelope>();
      await Promise.all(pending); expect(detail.status, detail.msg).toBe(200); expect(detail.data).toMatchObject({ id: 80, unit_name: '箱', unitName: '箱' }); expect(detail.data.storeInfo.unit_name).toBe('箱');
      expect(pending).toHaveLength(1); const after = await f.snapshot();
      for (const table of Object.keys(before)) if (!['store_product_log', 'store_visit'].includes(table)) expect(after[table], table).toEqual(before[table]);
      expect(after.store_product_log).toHaveLength(1); expect(after.store_product_log[0].row).toMatchObject({ product_id: 80, uid: 0, type: 'visit', visit_num: 1 });
      expect(after.store_visit).toHaveLength(1); expect(after.store_visit[0].row).toMatchObject({ product_id: 80, uid: 0, product_type: 'product', cate_id: 80, count: 1 }); expect(after.store_visit[0].row.type.trimEnd()).toBe('view');
      for (const table of ['store_product_attr_value', 'store_product_stock_record', 'store_product_virtual', 'store_order', 'store_order_cart_info', 'system_form_data', 'store_product_unit']) expect(after[table], table).toEqual(baseline[table]);
      const [rights] = await reader.db.execute(sql`SELECT current_user=session_user AS independent,
        has_any_column_privilege(current_user,'store_product','UPDATE') AS product_write,
        has_any_column_privilege(current_user,'store_product_log','INSERT') AS analytics_insert,
        has_any_column_privilege(current_user,'store_product_log','UPDATE') AS analytics_log_edit,
        has_table_privilege(current_user,'store_product_log','DELETE') AS analytics_log_delete,
        has_column_privilege(current_user,'store_visit','product_id','UPDATE') AS analytics_identity_edit,
        has_column_privilege(current_user,'store_visit','id','UPDATE') AS analytics_row_identity_edit,
        has_table_privilege(current_user,'store_visit','DELETE') AS analytics_visit_delete,
        has_table_privilege(current_user,'store_order','SELECT,INSERT,UPDATE,DELETE') AS orders_access,
        has_table_privilege(current_user,'system_form_data','SELECT,INSERT,UPDATE,DELETE') AS answers_access`);
      expect(rights).toEqual({ independent: true, product_write: false, analytics_insert: true, analytics_log_edit: false, analytics_log_delete: false, analytics_identity_edit: false, analytics_row_identity_edit: false, analytics_visit_delete: false, orders_access: false, answers_access: false });
    }));
  });
});
