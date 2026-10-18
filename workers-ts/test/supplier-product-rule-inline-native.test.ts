import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { storeProductAttr, storeProductAttrValue, storeOrder, storeOrderCartInfo } from '@/models/schema';
import { supplierProductRuleInlineFixture, type SupplierRuleInlineState } from './helpers/supplierProductRuleInline';
import { supplierProductScheduleBody } from './helpers/supplierProductSchedule';

type Dimension = { value: string; detail: string[] };
type Rule = { id: number; type: number; relation_id: number; rule_name: string; rule_value: string | Dimension[]; spec: Dimension[]; revision: string };
type Envelope = { status: number; msg: string; data: any };
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined, moderator: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned rule-inline HTTP LOGIN'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.moderator) throw Error('Missing owned rule-inline reviewer LOGIN'); return { container: wiring.moderator, close: async () => {} }; },
}));
const app = createApp(), prefix = '/product/product';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier inline rule actual App author and copied SKU Customer consumer on owned PG16', () => {
  let f: Awaited<ReturnType<typeof supplierProductRuleInlineFixture>>;
  let prepare: (spec: Dimension[], max?: number) => { items: Dimension[]; details: Array<Record<string, string>> };
  beforeAll(async () => {
    // Execute the actual frontend preparation module, not a rewritten cartesian
    // helper. Its Supplier-only @type aliases are resolved by its own tsconfig;
    // Worker semantic types do not import a different application's aliases.
    const supplierRoot = resolve(import.meta.dirname, '../../view/supplier-ts');
    const bundle = await build({ absWorkingDir: supplierRoot, entryPoints: ['src/utils/productRules.ts'],
      bundle: true, write: false, platform: 'node', format: 'esm', tsconfig: resolve(supplierRoot, 'tsconfig.app.json') });
    const actual = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
    prepare = actual.prepareSupplierProductRuleApplication;
    expect(typeof prepare).toBe('function');
  }, 30000);
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned rule-inline forbids backend provider I/O'));
    f = await supplierProductRuleInlineFixture(); wiring.container = f.container;
  }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { await f?.close(); wiring.container = undefined; wiring.moderator = undefined; vi.restoreAllMocks(); } }, 30000);

  async function supplier(method: string, path: string, body?: unknown, actor: keyof typeof f.tokens | 'anonymous' = 'manager') {
    const response = await app.request('/supplierapi' + path, { method, headers: {
      ...(actor === 'anonymous' ? {} : { Authorization: 'Bearer ' + f.tokens[actor] }), 'X-Supplier-Id': '8',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, f.env);
    expect(response.headers.get('cache-control')).toContain('private, no-store'); return response.json<Envelope>();
  }
  async function unchanged(work: () => Promise<unknown>) {
    const before = await f.snapshot(), seq = await f.sequences(); await work();
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(seq);
  }
  async function catalog() { const result = await supplier('GET', prefix + '/rule'); expect(result.status, result.msg).toBe(200); expect(result.data.revision).toMatch(/^[a-f0-9]{64}$/); return result.data; }
  async function detail(id: number) { const result = await supplier('GET', prefix + '/rule/' + id); expect(result.status, result.msg).toBe(200); return result.data.info as Rule; }
  function onlyRuleAndAudit(before: SupplierRuleInlineState, after: SupplierRuleInlineState, id: number, operation: 'create' | 'update' | 'delete', body = f.ruleBody()) {
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const name of Object.keys(before)) if (name !== 'store_product_rule' && name !== 'system_log') expect(after[name], name).toEqual(before[name]);
    expect(after.store_product_rule.filter(item => item.row.id !== id)).toEqual(before.store_product_rule.filter(item => item.row.id !== id));
    const target = after.store_product_rule.filter(item => item.row.id === id);
    if (operation === 'delete') expect(target).toEqual([]);
    else expect(target).toEqual([{ row: { id, type: 2, relation_id: 7, rule_name: body.rule_name, rule_value: JSON.stringify(body.spec) } }]);
    if (operation === 'create') expect(before.store_product_rule.some(item => item.row.id === id)).toBe(false);
    const oldIds = new Set(before.system_log.map(item => item.row.id));
    expect(after.system_log.filter(item => oldIds.has(item.row.id))).toEqual(before.system_log);
    const added = after.system_log.filter(item => !oldIds.has(item.row.id)); expect(added).toHaveLength(1);
    expect(added[0].row).toMatchObject({ admin_id: 21, merchant_id: 7, type: 'supplier_product_rule', method: operation === 'delete' ? 'DELETE' : 'POST',
      path: '/supplierapi' + prefix + (operation === 'delete' ? '/rule/delete/' + id : '/rule/' + (operation === 'create' ? 0 : id)) });
    expect(JSON.parse(added[0].row.action)).toEqual({ operation, ids: [id] });
  }
  async function createRule(name = '商品内新增规格模板') {
    const current = await catalog(), body = f.ruleBody(name), before = await f.snapshot();
    const saved = await supplier('POST', prefix + '/rule/0', { ...body, expected_revision: current.revision }); expect(saved.status, saved.msg).toBe(200);
    expect(saved.data).toEqual({ id: expect.any(Number), revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    onlyRuleAndAudit(before, await f.snapshot(), saved.data.id, 'create', body);
    const read = await detail(saved.data.id); expect(read).toMatchObject({ id: saved.data.id, type: 2, relation_id: 7, rule_name: body.rule_name, spec: body.spec, revision: saved.data.revision });
    return read;
  }

  it('reads complete own catalog detail and decoded get_rule under SELECT-only real Supplier LOGIN with zero rows or sequence writes', async () => f.withRuleReader(async runtime => {
    wiring.container = runtime.container;
    await unchanged(async () => {
      const list = await supplier('GET', prefix + '/rule', undefined, 'viewer'); expect(list.status, list.msg).toBe(200);
      expect(list.data).toMatchObject({ count: 2, page: 0, limit: 0 }); expect(list.data.list.map((row: Rule) => row.id)).toEqual([202, 201]);
      const read = await supplier('GET', prefix + '/rule/201', undefined, 'viewer'); expect(read.status, read.msg).toBe(200); expect(read.data.info).toEqual(list.data.list[1]);
      const options = await supplier('GET', prefix + '/get_rule', undefined, 'viewer'); expect(options.status, options.msg).toBe(200);
      expect(options.data.map((row: Rule) => row.id)).toEqual([202, 201]); expect(options.data[1].rule_value).toEqual(f.ruleBody().spec);
      expect(JSON.stringify(options.data)).not.toMatch(/外店私有规格|平台规格不可借用/);
    });
    const [rights] = await runtime.db.execute(sql`SELECT current_user=session_user AS independent,
      has_table_privilege(current_user,'store_product_rule','SELECT') AS rule_read,
      has_table_privilege(current_user,'store_product_rule','INSERT,DELETE') AS rule_mutation,
      has_any_column_privilege(current_user,'store_product_rule','UPDATE') AS rule_update,
      has_table_privilege(current_user,'system_log','INSERT') AS log_write,
      has_table_privilege(current_user,'store_order','SELECT,INSERT,UPDATE,DELETE') AS order_access`);
    expect(rights).toEqual({ independent: true, rule_read: true, rule_mutation: false, rule_update: false, log_write: false, order_access: false });
  }));

  it('creates fixed-owner full revision template through actual App under narrow rule/audit LOGIN and rereads all facts without touching persisted products', async () => f.withRuleWriter(async runtime => {
    wiring.container = runtime.container; const current = await catalog(), before = await f.snapshot(), seq = await f.sequences(), body = f.ruleBody();
    const saved = await supplier('POST', prefix + '/rule/0', { ...body, type: 0, relation_id: 8, expected_revision: current.revision }); expect(saved.status, saved.msg).toBe(200);
    expect(saved.data).toEqual({ id: expect.any(Number), revision: expect.stringMatching(/^[a-f0-9]{64}$/) }); expect(saved.data.id).toBeGreaterThan(301);
    onlyRuleAndAudit(before, await f.snapshot(), saved.data.id, 'create', body);
    await unchanged(async () => { const read = await detail(saved.data.id); expect(read).toMatchObject({ type: 2, relation_id: 7, rule_name: body.rule_name, spec: body.spec, revision: saved.data.revision });
      const options = await supplier('GET', prefix + '/get_rule'); expect(options.status, options.msg).toBe(200); expect(options.data.find((row: Rule) => row.id === saved.data.id).rule_value).toEqual(body.spec); });
    const allowed = new Set(['store_product_rule_id_seq', 'system_log_id_seq']); expect((await f.sequences()).filter(row => !allowed.has(row.name))).toEqual(seq.filter(row => !allowed.has(row.name)));
    const [rights] = await runtime.db.execute(sql`SELECT current_user=session_user AS independent,
      has_column_privilege(current_user,'system_admin','id','UPDATE') AS auth_lock,
      has_column_privilege(current_user,'system_admin','pwd','UPDATE') AS auth_edit,
      has_column_privilege(current_user,'store_product_rule','relation_id','UPDATE') AS owner_edit,
      has_any_column_privilege(current_user,'store_product','UPDATE') AS product_write,
      has_table_privilege(current_user,'store_product_attr_value','UPDATE') AS sku_write,
      has_table_privilege(current_user,'system_log','UPDATE,DELETE') AS audit_edit,
      has_table_privilege(current_user,'store_order','SELECT,INSERT,UPDATE,DELETE') AS order_access,
      has_table_privilege(current_user,'system_form_data','SELECT,INSERT,UPDATE,DELETE') AS answers_access`);
    expect(rights).toEqual({ independent: true, auth_lock: true, auth_edit: false, owner_edit: false, product_write: false, sku_write: false, audit_edit: false, order_access: false, answers_access: false });
  }));

  it.each(['anonymous', 'viewer', 'denied'] as const)('refuses %s rule creation editing and deletion without rows or sequence changes', async actor => f.withRuleWriter(async runtime => {
    wiring.container = runtime.container; const current = await catalog(), owned = await detail(201);
    await unchanged(async () => {
      for (const result of [await supplier('POST', prefix + '/rule/0', { ...f.ruleBody(), expected_revision: current.revision }, actor),
        await supplier('POST', prefix + '/rule/201', { ...f.ruleBody(), expected_revision: owned.revision }, actor),
        await supplier('DELETE', prefix + '/rule/delete/201', { expected_revision: owned.revision }, actor)]) expect(result.status).not.toBe(200);
    });
  }));

  it.each([101, 301, 999])('does not disclose change or delete platform foreign or missing rule%i even with forged Supplier header', async id => f.withRuleWriter(async runtime => {
    wiring.container = runtime.container; const owned = await detail(201);
    await unchanged(async () => {
      for (const result of [await supplier('GET', prefix + '/rule/' + id), await supplier('POST', prefix + '/rule/' + id, { ...f.ruleBody(), expected_revision: owned.revision }),
        await supplier('DELETE', prefix + '/rule/delete/' + id, { expected_revision: owned.revision })]) { expect(result.status).toBe(404); expect(result.msg).toContain('不属于'); }
    });
  }));

  it('rejects stale complete create catalog and stale edit/delete row revisions after genuine successful controls with zero additional writes', async () => f.withRuleWriter(async runtime => {
    wiring.container = runtime.container; const initial = await catalog(); await createRule('先提交的完整目录变更');
    await unchanged(async () => { const stale = await supplier('POST', prefix + '/rule/0', { ...f.ruleBody('旧目录不能新建'), expected_revision: initial.revision }); expect(stale.status).toBe(409); });
    const prior = await detail(201), before = await f.snapshot(), body = f.ruleBody('先提交的真实编辑');
    const control = await supplier('POST', prefix + '/rule/201', { ...body, expected_revision: prior.revision }); expect(control.status, control.msg).toBe(200); onlyRuleAndAudit(before, await f.snapshot(), 201, 'update', body);
    await unchanged(async () => {
      expect((await supplier('POST', prefix + '/rule/201', { ...f.ruleBody('旧行不能覆盖'), expected_revision: prior.revision })).status).toBe(409);
      expect((await supplier('DELETE', prefix + '/rule/delete/201', { expected_revision: prior.revision })).status).toBe(409);
    });
  }));

  it('copies newly authored actual frontend two-by-two rule into new Supplier product fourSKUs then real Admin review and Customer qty2 confirm/create while later rule edit/delete preserves order and SKU history', async () => {
    const checkout = await f.prepareCheckout();
    expect(f.buyerSqlBoundary).toBe('owned finance_test maintenance connection'); const [buyerSql] = await f.db.execute(sql`SELECT current_user AS role`); expect(buyerSql.role).toBe('finance_test');
    const history = await f.snapshot(); let rule!: Rule;
    await f.withRuleWriter(async runtime => { wiring.container = runtime.container; rule = await createRule('真实下单商品规格'); });
    const source = JSON.stringify(rule.spec), candidate = prepare(rule.spec); expect(JSON.stringify(rule.spec)).toBe(source);
    expect(candidate.items).toEqual(f.ruleBody().spec); expect(candidate.details).toEqual([{ 颜色: '红', 尺码: 'S' }, { 颜色: '红', 尺码: 'M' }, { 颜色: '蓝', 尺码: 'S' }, { 颜色: '蓝', 尺码: 'M' }]);
    const attrs = candidate.details.map((detail, index) => ({ detail, suk: candidate.items.map(item => detail[item.value]).join(','), image: '/owned-media/rule-inline.png',
      price: (12.5 + index).toFixed(2), settle_price: '8.25', cost: '4.00', ot_price: '20.00', vip_price: '0.00', stock: 7, bar_code: 'INLINE-' + index, code: 'RULE-' + index, weight: '0.10', volume: '0.10' }));
    let productId = 0;
    await f.withWriter(async runtime => {
      wiring.container = runtime.container;
      const saved = await supplier('POST', prefix + '/0', supplierProductScheduleBody({ store_name: '实际模板SKU商品', spec_type: 1, items: candidate.items, attrs,
        slider_image: ['/owned-media/rule-inline.png'], description: '<p>模板结构明确复制后独立保存</p>', freight: 1, delivery_type: ['1'] }));
      expect(saved.status, saved.msg).toBe(200); expect(saved.data).toMatchObject({ id: expect.any(Number), is_verify: 0, is_show: 0 }); productId = saved.data.id; expect(productId).not.toBe(80);
      await unchanged(async () => { const read = await supplier('GET', prefix + '/' + productId); expect(read.status, read.msg).toBe(200); expect(read.data.items).toEqual(candidate.items); expect(read.data.attrs).toHaveLength(4); });
    });
    const skus = await f.db.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, productId), eq(storeProductAttrValue.type, 0))).orderBy(asc(storeProductAttrValue.id));
    expect(skus).toHaveLength(4); expect(new Set(skus.map(row => row.unique)).size).toBe(4); expect(skus.every(row => row.unique.length >= 8 && row.stock === 7 && row.isRetired === 0)).toBe(true);
    expect(skus.map(row => [row.suk, row.price, row.settlePrice, row.stock])).toEqual(attrs.map(row => [row.suk, row.price, row.settle_price, 7]));
    const dimensions = await f.db.select().from(storeProductAttr).where(eq(storeProductAttr.productId, productId)).orderBy(asc(storeProductAttr.id)); expect(dimensions.map(row => [row.attrName, row.attrValues])).toEqual([['颜色', '红,蓝'], ['尺码', 'S,M']]);
    const beforeApproval = await f.snapshot();
    await f.withModerator(async runtime => {
      wiring.container = f.container; wiring.moderator = runtime.container;
      const response = await app.request('/adminapi/product/product/set_verify/' + productId, { method: 'POST', headers: { Authorization: 'Bearer ' + f.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ is_verify: 1, is_show: 1, refusal: '', auto_on_time: '' }) }, f.env);
      const reviewed = await response.json<Envelope>(); expect(reviewed.status, reviewed.msg).toBe(200);
    });
    expect(await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, productId)).orderBy(asc(storeProductAttrValue.id))).toEqual(skus);
    const afterApproval = await f.snapshot(); expect(afterApproval.store_order).toEqual(beforeApproval.store_order); expect(afterApproval.store_order_cart_info).toEqual(beforeApproval.store_order_cart_info); expect(afterApproval.system_form_data).toEqual(beforeApproval.system_form_data);
    const customer = async (path: string, body: unknown) => { wiring.container = f.container;
      const response = await app.request('/api' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + checkout.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, f.env); return response.json<Envelope>(); };
    const selected = skus.find(row => row.suk === '蓝,S')!; expect(selected.price).toBe('14.50');
    const added = await customer('/cart/add', { productId, unique: selected.unique, cartNum: 2, type: 0, new: 1 }); expect(added.status, added.msg).toBe(200);
    const input = { cartIds: [Number(added.data.id)], addressId: 11, shippingType: 1, useIntegral: false };
    const quoted = await customer('/order/confirm', input); expect(quoted.status, quoted.msg).toBe(200); expect(quoted.data.priceGroup).toMatchObject({ sumPrice: '29.00', total_price: '29.00', pay_price: '29.00', pay_postage: '0.00' });
    const beforeCreate = await f.snapshot(), created = await customer('/order/create/' + quoted.data.orderKey, { ...input, quoteToken: quoted.data.quoteToken, customForm: [] }); expect(created.status, created.msg).toBe(200);
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.data.orderId)); expect(order).toMatchObject({ uid: 11, totalNum: 2, totalPrice: '29.00', payPrice: '29.00', payPostage: '0.00', customForm: '[]' });
    const lines = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id)); expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ productId, skuUnique: selected.unique, cartNum: 2, settlePrice: '8.25' });
    expect(lines[0].cartInfo).toBeTypeOf('string'); expect(JSON.parse(lines[0].cartInfo!)).toMatchObject({ cart_num: 2, product: { id: productId }, sku: { id: selected.id, unique: selected.unique, suk: '蓝,S', price: '14.50' }, sum_true_price: '29.00' });
    const boughtSkus = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, productId)).orderBy(asc(storeProductAttrValue.id));
    expect(boughtSkus.map(row => ({ ...row, stock: row.stock + (row.id === selected.id ? 2 : 0), sales: row.sales - (row.id === selected.id ? 2 : 0) }))).toEqual(skus);
    expect((await f.product(productId)).stock).toBe(beforeCreate.store_product.find(item => item.row.id === productId)!.row.stock - 2);
    const bought = await f.snapshot(); expect(bought.store_order.filter(item => item.row.uid === 999)).toEqual(history.store_order.filter(item => item.row.uid === 999)); expect(bought.store_order_cart_info.filter(item => item.row.uid === 999)).toEqual(history.store_order_cart_info.filter(item => item.row.uid === 999)); expect(bought.system_form_data).toEqual(history.system_form_data);
    for (const name of ['store_product', 'store_product_attr', 'store_product_attr_value', 'store_product_attr_result', 'store_product_description', 'store_product_stock_record']) {
      const idField = name === 'store_product' ? 'id' : 'product_id';
      expect(bought[name].filter(item => item.row[idField] !== productId), name).toEqual(history[name]);
    }
    await f.withRuleWriter(async runtime => {
      wiring.container = runtime.container; const beforeEdit = await f.snapshot(), renamed = { rule_name: '模板变更不得改已下单商品', spec: [{ value: '包装', detail: ['新包装'] }] };
      const edited = await supplier('POST', prefix + '/rule/' + rule.id, { ...renamed, expected_revision: rule.revision }); expect(edited.status, edited.msg).toBe(200); onlyRuleAndAudit(beforeEdit, await f.snapshot(), rule.id, 'update', renamed);
      const beforeDelete = await f.snapshot(); const removed = await supplier('DELETE', prefix + '/rule/delete/' + rule.id, { expected_revision: edited.data.revision }); expect(removed.status, removed.msg).toBe(200); expect(removed.data).toBeNull(); onlyRuleAndAudit(beforeDelete, await f.snapshot(), rule.id, 'delete');
    });
    expect((await f.db.select().from(storeOrder).where(eq(storeOrder.id, order.id)))[0]).toEqual(order); expect(await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id))).toEqual(lines);
    expect(await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, productId)).orderBy(asc(storeProductAttrValue.id))).toEqual(boughtSkus);
  }, 90000);
});
