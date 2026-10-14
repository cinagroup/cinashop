import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { storeProductRule, storeProduct, storeProductAttr, storeProductAttrValue,
  storeProductAttrResult, storeProductStockRecord, systemAdmin, systemRole, systemMenus, systemLog } from '@/models/schema';
import { ProductMetadataService } from '@/services/product/ProductMetadataService';
import { ProductAssociationService } from '@/services/product/ProductAssociationService';
import { AdminPermissionService } from '@/services/admin/AdminPermissionService';
import { productRuleFixture, seedRules, ruleActor, ruleBody } from './helpers/adminProductRules';

const query = () => new URLSearchParams();
describe('Admin SKU rule PHP contracts, authority, SQL receipts and copied product snapshots', () => {
  let f: Awaited<ReturnType<typeof productRuleFixture>>;
  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Rule fixture forbids external I/O'));
    f = await productRuleFixture();
  }, 30000);
  beforeEach(async () => {
    await f.exec(`DROP TRIGGER IF EXISTS skip_rule_dml ON store_product_rule;
      DROP TRIGGER IF EXISTS rewrite_rule_dml ON store_product_rule;
      DROP TRIGGER IF EXISTS skip_rule_audit ON system_log;
      DROP TRIGGER IF EXISTS rewrite_rule_audit ON system_log;
      DROP TRIGGER IF EXISTS rewrite_rule_audit_identity ON system_log;
      DROP TRIGGER IF EXISTS mutate_rule_after_audit ON system_log;
      DROP TRIGGER IF EXISTS rewrite_rule_audit_after ON system_log;
      DROP TRIGGER IF EXISTS resurrect_rule_after_audit ON system_log`);
    await f.reset(); await seedRules(f.db);
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_rule','id'),1000,false)");
  }, 30000);
  afterAll(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30000);
  const remove = (id = 11, body: unknown = undefined, actor = ruleActor(), legacy = true) =>
    f.service.remove(id, query(), body, actor, legacy);
  async function snapshot() {
    return { rules: await f.db.select().from(storeProductRule).orderBy(storeProductRule.id),
      logs: await f.db.select().from(systemLog).orderBy(systemLog.id) };
  }

  it('returns PHP raw list values, parsed selector values and detail spec without adding list spec or detail attrs', async () => {
    const raw = JSON.stringify(ruleBody().spec);
    expect(await f.service.list(new URLSearchParams('page=2&limit=1'), ruleActor())).toEqual({ count: 2,
      list: [{ id: 10, type: 0, relation_id: 0, rule_name: '服装', rule_value: raw,
        attr_name: '颜色,尺码', attr_value: ['红,蓝', 'S,M'] }] });
    const templates = await f.service.templates(query(), ruleActor());
    expect(templates.map(row => row.id)).toEqual([11, 10]);
    expect(templates[1]).toEqual({ id: 10, type: 0, relation_id: 0, rule_name: '服装',
      rule_value: ruleBody().spec, attr_name: '颜色,尺码', attr_value: ['红,蓝', 'S,M'] });
    expect(await f.service.detail(10, query(), ruleActor())).toEqual({ info: {
      id: 10, type: 0, relation_id: 0, rule_name: '服装', rule_value: raw, spec: ruleBody().spec,
    } });
    const modern = await f.service.list(new URLSearchParams('page=2&limit=1'), ruleActor(), false);
    expect(modern).toMatchObject({ page: 2, limit: 1, count: 2, list: [{ id: 10, spec: ruleBody().spec }] });
    expect(await f.service.detail(10, query(), ruleActor(), false)).toMatchObject({ info: {
      spec: ruleBody().spec, attr_name: '颜色,尺码', attr_value: ['红,蓝', 'S,M'],
    } });
  });

  it('matches PHP name-only LIKE filtering and isolates every foreign or malformed owner', async () => {
    expect((await f.service.list(new URLSearchParams('rule_name=10'), ruleActor())).count).toBe(0);
    expect((await f.service.list(new URLSearchParams('rule_name=服'), ruleActor())).list.map(row => row.id)).toEqual([10]);
    expect((await f.service.list(new URLSearchParams('rule_name=%'), ruleActor())).count).toBe(2);
    const before = await snapshot();
    for (const id of [20, 21, 22, 30, 999]) {
      await expect(f.service.detail(id, query(), ruleActor())).rejects.toThrow('不存在');
      await expect(f.service.save(id, ruleBody(), ruleActor())).rejects.toThrow('不存在');
      await expect(remove(id)).rejects.toThrow('不存在');
    }
    expect(await snapshot()).toEqual(before);
    const core = new ProductMetadataService(f.container), supplier = { type: 2, relationId: 20 } as const;
    expect((await core.ruleTemplates(supplier)).map(row => row.id)).toEqual([20]);
    for (const id of [10, 21, 22, 30]) await expect(core.ruleDetail(supplier, id)).rejects.toThrow('不存在');
    await expect(f.service.save(0, ruleBody({ rule_name: '服装' }), ruleActor())).rejects.toThrow('已存在');
    expect(await core.saveRule(supplier, 0, ruleBody({ rule_name: '服装' }))).toEqual({ id: 1000 });
    expect((await f.service.templates(query(), ruleActor())).map(row => row.id)).toEqual([11, 10]);
  });

  it('preserves PHP falsy raw values and decoded empty/invalid JSON differences from the modern safe projection', async () => {
    const cases: Array<{ raw: string | null; decoded: unknown; attrs: boolean }> = [
      { raw: null, decoded: null, attrs: false }, { raw: '', decoded: null, attrs: false },
      { raw: '0', decoded: 0, attrs: false }, { raw: '[]', decoded: [], attrs: true },
      { raw: '{}', decoded: {}, attrs: true }, { raw: 'false', decoded: false, attrs: true },
      { raw: 'null', decoded: null, attrs: true }, { raw: '{invalid', decoded: null, attrs: true },
    ];
    await f.db.insert(storeProductRule).values(cases.map((item, i) => ({ id: 100 + i, ruleName: `历史${i}`, ruleValue: item.raw })));
    for (const [i, item] of cases.entries()) {
      const legacy = (await f.service.list(new URLSearchParams(`rule_name=历史${i}`), ruleActor())).list[0];
      expect(legacy).toEqual({ id: 100 + i, type: 0, relation_id: 0, rule_name: `历史${i}`, rule_value: item.raw,
        ...(item.attrs ? { attr_name: '', attr_value: [''] } : {}) });
      expect(await f.service.detail(100 + i, query(), ruleActor())).toEqual({ info: {
        id: 100 + i, type: 0, relation_id: 0, rule_name: `历史${i}`, rule_value: item.raw, spec: item.decoded,
      } });
      const template = (await f.service.templates(query(), ruleActor())).find(row => row.id === 100 + i);
      expect(template).toEqual({ id: 100 + i, type: 0, relation_id: 0, rule_name: `历史${i}`,
        rule_value: item.attrs ? item.decoded : item.raw, ...(item.attrs ? { attr_name: '', attr_value: [''] } : {}) });
      expect(await f.service.detail(100 + i, query(), ruleActor(), false)).toMatchObject({ info: { spec: [], attr_value: [] } });
    }
    const emptyEcho = (await f.service.list(new URLSearchParams('rule_name=历史3'), ruleActor())).list[0];
    await f.service.save(emptyEcho.id, { ...emptyEcho, spec: [{ value: '修复', detail: ['可用'] }] }, ruleActor());
    expect((await f.service.detail(emptyEcho.id, query(), ruleActor())).info.spec).toEqual([{ value: '修复', detail: ['可用'] }]);
  });

  it('refuses unusable truthy historical list/template shapes while retaining the decoded detail for repair', async () => {
    for (const raw of ['true', '1', '"text"', '[1]', '[{"value":"颜色","detail":1}]']) {
      await f.db.update(storeProductRule).set({ ruleValue: raw }).where(eq(storeProductRule.id, 11));
      await expect(f.service.list(query(), ruleActor())).rejects.toThrow('结构异常');
      await expect(f.service.templates(query(), ruleActor())).rejects.toThrow('结构异常');
      expect((await f.service.detail(11, query(), ruleActor())).info.spec).toEqual(JSON.parse(raw));
      expect((await f.service.detail(11, query(), ruleActor(), false)).info.spec).toEqual([]);
    }
    expect(await f.db.select().from(systemLog)).toEqual([]);
  });

  it('accepts actual full editor and selector echoes but refuses forged raw/derived metadata and stale echoes atomically', async () => {
    const legacy = (await f.service.detail(10, query(), ruleActor())).info;
    await f.service.save(10, { ...legacy, rule_name: '旧完整回显编辑', spec: [{ value: '材质', detail: ['钢'] }] }, ruleActor());
    const modern = (await f.service.detail(10, query(), ruleActor(), false)).info;
    const before = await snapshot();
    for (const change of [{ id: 11 }, { type: 2 }, { relation_id: 20 }, { rule_value: '[]' },
      { attr_name: '伪造' }, { attr_value: ['假'] }, { ruleName: '冲突' }, { owner_id: 0 }, { unknown: true }]) {
      await expect(f.service.save(10, { ...modern, ...change }, ruleActor())).rejects.toThrow();
    }
    await expect(f.service.save(10, legacy, ruleActor())).rejects.toThrow('回显');
    expect(await snapshot()).toEqual(before);
    const selected = (await f.service.templates(query(), ruleActor(), false)).find(row => row.id === 10)!;
    await f.service.save(10, { ...selected, rule_name: '合法解析值回显' }, ruleActor());
    expect((await f.service.detail(10, query(), ruleActor())).info.rule_name).toBe('合法解析值回显');
  });

  it('supports 32/32/64 Unicode codepoints and aliases without applying the older UI maxlength bounds to the API', async () => {
    const name = '😀'.repeat(32), dimension = '😀'.repeat(32), value = '😀'.repeat(64);
    const result = await f.service.save(0, ruleBody({ rule_name: name, spec: [{ value: dimension, detail: [value] }] }), ruleActor());
    expect((await f.service.detail(result.id, query(), ruleActor())).info).toMatchObject({ rule_name: name, spec: [{ value: dimension, detail: [value] }] });
    expect((await f.service.list(new URLSearchParams({ rule_name: name }), ruleActor())).count).toBe(1);
    await f.service.save(result.id, { ruleName: name, spec: [{ attr_name: '别名', attr_values: ['值'] }] }, ruleActor());
    const before = await snapshot();
    for (const body of [ruleBody({ rule_name: '😀'.repeat(33) }),
      ruleBody({ spec: [{ value: '😀'.repeat(33), detail: ['值'] }] }),
      ruleBody({ spec: [{ value: '名', detail: ['😀'.repeat(65)] }] })]) {
      await expect(f.service.save(0, body, ruleActor())).rejects.toThrow();
    }
    expect(await snapshot()).toEqual(before);
  });

  it('accepts decoded selector echoes with source object key order and rejects extra keys or changed array order', async () => {
    await f.db.insert(storeProductRule).values({ id: 12, ruleName: '键顺序规格',
      ruleValue: '[{"detail":["蓝"],"value":"颜色"}]' });
    const selected = (await f.service.templates(query(), ruleActor())).find(row => row.id === 12)!;
    expect(selected.rule_value).toEqual([{ value: '颜色', detail: ['蓝'] }]);
    const before = await snapshot();
    await expect(f.service.save(12, { ...selected, rule_value: [{ detail: ['蓝'], value: '颜色', extra: true }],
      spec: [{ value: '颜色', detail: ['绿'] }] }, ruleActor())).rejects.toThrow('回显');
    expect(await snapshot()).toEqual(before);
    expect(await f.service.save(12, { ...selected, spec: [{ value: '颜色', detail: ['绿'] }] }, ruleActor())).toEqual({ id: 12 });
    await f.db.update(storeProductRule).set({ ruleValue: '[{"detail":["蓝","红"],"value":"颜色"}]' }).where(eq(storeProductRule.id, 12));
    const twoValues = (await f.service.templates(query(), ruleActor())).find(row => row.id === 12)!;
    const original = await snapshot();
    await expect(f.service.save(12, { ...twoValues, rule_value: [{ value: '颜色', detail: ['红', '蓝'] }],
      spec: [{ value: '颜色', detail: ['绿'] }] }, ruleActor())).rejects.toThrow('回显');
    expect(await snapshot()).toEqual(original);
    expect(await f.service.save(12, { ...twoValues, spec: [{ value: '颜色', detail: ['绿'] }] }, ruleActor())).toEqual({ id: 12 });
  });

  it('copies a template containing 32 emoji name and 64 emoji value into a real SKU SQL snapshot at the exact boundary', async () => {
    const dimension = '😀'.repeat(32), value = '😀'.repeat(64);
    const created = await f.service.save(0, ruleBody({ rule_name: 'Unicode规格', spec: [{ value: dimension, detail: [value] }] }), ruleActor());
    const product = new ProductAssociationService(f.container);
    const template = (await product.editorOptions()).sku_rule_templates.find(row => row.id === created.id)!;
    expect(template.dimensions).toEqual([{ value: dimension, detail: [value] }]);
    const actor = { id: 101, name: 'Unicode copied SKU fixture', ip: '127.0.0.1' };
    const body = { store_name: 'Unicode完整规格商品', unit_name: '件', product_type: 0, spec_type: 1,
      items: structuredClone(template.dimensions), attrs: [{ suk: value, detail: { [dimension]: value },
        price: 12, cost: 4, ot_price: 20, vip_price: 9, stock: 5 }] };
    const saved = await product.save(0, body, actor);
    expect(saved.sku_verified).toBe(true);
    const dimensions = await f.db.select().from(storeProductAttr).where(eq(storeProductAttr.productId, saved.id));
    expect(dimensions).toMatchObject([{ attrName: dimension, attrValues: value }]);
    const values = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, saved.id));
    expect(values).toMatchObject([{ suk: value, stock: 5, price: '12.00' }]);
    expect(values[0].unique).toHaveLength(8);
    const results = await f.db.select().from(storeProductAttrResult).where(eq(storeProductAttrResult.productId, saved.id));
    expect(results).toHaveLength(1);
    const before = { product: await f.db.select().from(storeProduct), dimensions: await f.db.select().from(storeProductAttr),
      values: await f.db.select().from(storeProductAttrValue), results: await f.db.select().from(storeProductAttrResult),
      logs: await f.db.select().from(systemLog) };
    for (const [name, item] of [['😀'.repeat(33), value], [dimension, '😀'.repeat(65)]]) {
      await expect(product.save(0, { ...body, items: [{ value: name, detail: [item] }],
        attrs: [{ ...body.attrs[0], suk: item, detail: { [name]: item } }] }, actor)).rejects.toThrow();
    }
    expect({ product: await f.db.select().from(storeProduct), dimensions: await f.db.select().from(storeProductAttr),
      values: await f.db.select().from(storeProductAttrValue), results: await f.db.select().from(storeProductAttrResult),
      logs: await f.db.select().from(systemLog) }).toEqual(before);
  });

  it('validates dimension cardinality, duplicates, conflicting aliases, scalar identity and unsafe characters', async () => {
    const invalidSpecs = [[], new Array(4).fill({ value: '维度', detail: ['值'] }),
      [{ value: '维度', detail: [] }], [{ value: '维度', detail: Array.from({ length: 51 }, (_, i) => String(i)) }],
      [{ value: '维度', detail: ['值', ' 值 '] }], [{ value: '同', detail: ['1'] }, { value: '同', detail: ['2'] }],
      [{ value: '名', attr_name: '冲突', detail: ['1'] }], [{ value: '名', detail: ['1'], attr_values: ['2'] }],
      [{ value: '名', detail: ['1'], unknown: 1 }], [{ value: '\ud800', detail: ['1'] }],
      [{ value: '名', detail: ['坏\u0000值'] }], [{ value: true, detail: ['1'] }], [{ value: '名', detail: [1] }]];
    const before = await snapshot();
    for (const spec of invalidSpecs) await expect(f.service.save(0, ruleBody({ spec }), ruleActor())).rejects.toThrow();
    for (const body of [null, [], ruleBody({ rule_name: '' }), ruleBody({ rule_name: '\udfff' }),
      ruleBody({ rule_name: '坏\n名' }), ruleBody({ id: '00' }), ruleBody({ id: true })]) {
      await expect(f.service.save(0, body, ruleActor())).rejects.toThrow();
    }
    expect(await snapshot()).toEqual(before);
  });

  it('rejects repeated/unsupported queries, malformed pages and nonempty modern deletion bodies', async () => {
    const before = await snapshot();
    for (const input of ['page=0', 'page=01', 'limit=101', 'page=2147483647&limit=2',
      'page=1&page=2', 'rule_name=a&rule_name=b', 'type=0', 'rule_name='+encodeURIComponent('\n')]) {
      await expect(f.service.list(new URLSearchParams(input), ruleActor())).rejects.toThrow();
    }
    await expect(f.service.templates(new URLSearchParams('page=1'), ruleActor())).rejects.toThrow();
    await expect(f.service.detail(10, new URLSearchParams('id=10'), ruleActor())).rejects.toThrow();
    await expect(f.service.remove(11, new URLSearchParams('id=11'), undefined, ruleActor())).rejects.toThrow();
    for (const id of [0, -1, NaN, 2147483648]) await expect(f.service.detail(id, query(), ruleActor())).rejects.toThrow();
    for (const body of [null, {}, [], { ids: '11' }, { ids: '', unknown: 1 }]) await expect(remove(11, body)).rejects.toThrow();
    await expect(remove(11, { ids: '' }, ruleActor(), false)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(await remove(11, { ids: '' })).toBeNull();
  });

  it('admits exact page 99 and numeric API readers but rejects page 580 and every claimed tuple rewrite', async () => {
    const permission = new AdminPermissionService(f.container);
    for (const id of [102, 105, 106]) {
      expect((await f.service.list(query(), ruleActor(id))).count).toBe(2);
      await expect(f.service.save(0, ruleBody(), ruleActor(id))).rejects.toThrow('权限');
      await expect(remove(11, undefined, ruleActor(id))).rejects.toThrow('权限');
    }
    for (const id of [103, 107]) await expect(f.service.templates(query(), ruleActor(id))).rejects.toThrow('权限');
    expect(await permission.resolveManyRulePermissionKeys(['99', '580'])).toEqual([['product.view'], []]);
    const original = { type: 1, authType: 1, menuPath: '/admin/product/product_attr', uniqueAuth: 'product-product-attr', apiUrl: '', methods: '' };
    for (const change of [{ type: 2 }, { authType: 2 }, { menuPath: '/admin/product/product_Attr' },
      { uniqueAuth: 'product-product-Attr' }, { apiUrl: 'product/product/rule' }, { methods: 'GET' }]) {
      await f.db.update(systemMenus).set({ ...original, ...change }).where(eq(systemMenus.id, 99));
      expect(await permission.resolveRulePermissionKeys('99')).toEqual([]);
      expect(await permission.resolveManyRulePermissionKeys(['99'])).toEqual([[]]);
    }
    for (const tuple of [original, { ...original, authType: 2, apiUrl: 'product/product/rule/<id>', methods: 'POST' },
      { ...original, authType: 2, apiUrl: 'product/product/rule/delete', methods: 'DELETE' }]) {
      await f.db.update(systemMenus).set(tuple).where(eq(systemMenus.id, 580));
      expect(await permission.resolveRulePermissionKeys('580')).toEqual([]);
      expect(await permission.resolveManyRulePermissionKeys(['580'])).toEqual([[]]);
      await expect(f.service.list(query(), ruleActor(107))).rejects.toThrow('权限');
    }
    expect(await f.db.select().from(systemLog)).toEqual([]);
  });

  it('uses current roles/password/account owner and expires live actors at the SQL boundary', async () => {
    const before = await snapshot();
    await f.db.update(systemRole).set({ rules: 'user.view' }).where(eq(systemRole.id, 1));
    await expect(f.service.save(0, ruleBody(), ruleActor())).rejects.toThrow('权限');
    await f.db.update(systemAdmin).set({ pwd: 'changed' }).where(eq(systemAdmin.id, 102));
    await expect(f.service.list(query(), ruleActor(102))).rejects.toThrow('凭据');
    await f.db.update(systemAdmin).set({ adminType: 4, relationId: 20 }).where(eq(systemAdmin.id, 100));
    await expect(f.service.templates(query(), ruleActor(100))).rejects.toThrow('身份');
    await expect(f.service.save(10, ruleBody(), { ...ruleActor(), expiresAt: 1 })).rejects.toThrow('过期');
    await expect(f.service.detail(10, query(), { ...ruleActor(105), expiresAt: 1 })).rejects.toThrow('过期');
    expect(await snapshot()).toEqual(before);
  });

  it('records numeric writers with committed create/update/delete IDs and precise operation audit receipts', async () => {
    const actor = ruleActor(104), created = await f.service.save(0, ruleBody(), actor);
    expect(created).toEqual({ id: 1000 });
    expect(await f.service.save(created.id, ruleBody({ rule_name: '数字授权编辑' }), actor)).toEqual(created);
    expect(await remove(created.id, undefined, actor, false)).toBeNull();
    expect((await f.db.select().from(systemLog).orderBy(systemLog.id)).map(row => ({
      adminId: row.adminId, method: row.method, type: row.type, action: JSON.parse(row.action), path: row.path,
    }))).toEqual(['create', 'update', 'delete'].map(operation => ({ adminId: 104,
      method: operation === 'delete' ? 'DELETE' : 'POST', type: 'product_rule_catalog',
      action: { operation, id: created.id }, path: `product/product/rule/${created.id}` })));
    expect(await f.db.select().from(storeProductRule).where(eq(storeProductRule.id, created.id))).toEqual([]);
  });

  it('rolls back all DML operations whose SQL trigger skips or rewrites the complete business receipt', async () => {
    const before = await snapshot();
    await f.exec("CREATE FUNCTION skip_rule_dml() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER skip_rule_dml BEFORE INSERT OR UPDATE OR DELETE ON store_product_rule FOR EACH ROW EXECUTE FUNCTION skip_rule_dml()");
    await expect(f.service.save(0, ruleBody(), ruleActor())).rejects.toThrow('回执');
    await expect(f.service.save(11, ruleBody(), ruleActor())).rejects.toThrow('回执');
    await expect(remove()).rejects.toThrow('回执');
    expect(await snapshot()).toEqual(before);
    await f.exec('DROP TRIGGER skip_rule_dml ON store_product_rule');
    await f.exec("CREATE FUNCTION rewrite_rule_dml() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.rule_name='触发器改写'; RETURN NEW; END $$; CREATE TRIGGER rewrite_rule_dml BEFORE INSERT OR UPDATE ON store_product_rule FOR EACH ROW EXECUTE FUNCTION rewrite_rule_dml()");
    await expect(f.service.save(0, ruleBody(), ruleActor())).rejects.toThrow('回执');
    await expect(f.service.save(11, ruleBody(), ruleActor())).rejects.toThrow('回执');
    expect(await snapshot()).toEqual(before);
    await f.exec('DROP TRIGGER rewrite_rule_dml ON store_product_rule');
  });

  it('rolls back every mutation on skipped/rewritten audit receipts or a business row changed after its audit', async () => {
    const before = await snapshot();
    await f.exec("CREATE FUNCTION skip_rule_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER skip_rule_audit BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION skip_rule_audit()");
    await expect(f.service.save(0, ruleBody(), ruleActor())).rejects.toThrow('审计');
    await expect(f.service.save(11, ruleBody(), ruleActor())).rejects.toThrow('审计');
    await expect(remove()).rejects.toThrow('审计');
    expect(await snapshot()).toEqual(before);
    await f.exec('DROP TRIGGER skip_rule_audit ON system_log');
    await f.exec("CREATE FUNCTION rewrite_rule_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.method='GET'; RETURN NEW; END $$; CREATE TRIGGER rewrite_rule_audit BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION rewrite_rule_audit()");
    await expect(f.service.save(0, ruleBody(), ruleActor())).rejects.toThrow('审计');
    await expect(f.service.save(11, ruleBody(), ruleActor())).rejects.toThrow('审计');
    await expect(remove()).rejects.toThrow('审计');
    expect(await snapshot()).toEqual(before);
    await f.exec('DROP TRIGGER rewrite_rule_audit ON system_log');
    await f.exec("CREATE FUNCTION mutate_rule_after_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_product_rule SET rule_name='审计后改写' WHERE id=(NEW.action::jsonb->>'id')::integer; RETURN NEW; END $$; CREATE TRIGGER mutate_rule_after_audit AFTER INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION mutate_rule_after_audit()");
    await expect(f.service.save(0, ruleBody(), ruleActor())).rejects.toThrow('审计后');
    await expect(f.service.save(11, ruleBody(), ruleActor())).rejects.toThrow('审计后');
    expect(await snapshot()).toEqual(before);
    await f.exec('DROP TRIGGER mutate_rule_after_audit ON system_log');
  });

  it('detects audit readback changes and deleted-row resurrection in another owner without committing either effect', async () => {
    const before = await snapshot();
    await f.exec("CREATE FUNCTION rewrite_rule_audit_after() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE system_log SET page='审计后改写' WHERE id=NEW.id; RETURN NEW; END $$; CREATE TRIGGER rewrite_rule_audit_after AFTER INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION rewrite_rule_audit_after()");
    await expect(f.service.save(0, ruleBody(), ruleActor())).rejects.toThrow('审计回读');
    expect(await snapshot()).toEqual(before);
    await f.exec('DROP TRIGGER rewrite_rule_audit_after ON system_log');
    await f.exec("CREATE FUNCTION resurrect_rule_after_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO store_product_rule(id,type,relation_id,rule_name,rule_value) VALUES ((NEW.action::jsonb->>'id')::integer,2,20,'审计重建','[]'); RETURN NEW; END $$; CREATE TRIGGER resurrect_rule_after_audit AFTER INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION resurrect_rule_after_audit()");
    await expect(remove()).rejects.toThrow('审计后删除');
    expect(await snapshot()).toEqual(before);
    await f.exec('DROP TRIGGER resurrect_rule_after_audit ON system_log');
  });

  it('rolls back create/update/delete when each platform audit identity field changes before INSERT or after INSERT', async () => {
    const before = await snapshot();
    const columns = [['store_id', '73'], ['merchant_id', '91'], ['admin_name', "'forged-name'"],
      ['ip', "'203.0.113.73'"]] as const;
    let reached = 0;
    for (const phase of ['BEFORE', 'AFTER'] as const) {
      for (const [column, value] of columns) {
        const effect = phase === 'BEFORE' ? `NEW.${column}=${value};` : `UPDATE system_log SET ${column}=${value} WHERE id=NEW.id;`;
        await f.exec(`CREATE OR REPLACE FUNCTION rewrite_rule_audit_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${effect} RETURN NEW; END $$;
          CREATE TRIGGER rewrite_rule_audit_identity ${phase} INSERT ON system_log FOR EACH ROW
          WHEN (NEW.type='product_rule_catalog') EXECUTE FUNCTION rewrite_rule_audit_identity()`);
        try {
          const mutations = [() => f.service.save(0, ruleBody({ rule_name: `身份回执新增${reached}` }), ruleActor()),
            () => f.service.save(10, ruleBody({ rule_name: `身份回执编辑${reached}` }), ruleActor()), () => remove()];
          for (const mutate of mutations) {
            // Exact receipt/readback failure proves SQL reached the audited
            // operation, rather than an earlier name, input or role refusal.
            await expect(mutate()).rejects.toThrow(phase === 'BEFORE' ? '审计回执不完整' : '审计回读不一致');
            reached++;
            expect(await snapshot()).toEqual(before);
          }
        } finally { await f.exec('DROP TRIGGER IF EXISTS rewrite_rule_audit_identity ON system_log'); }
      }
    }
    expect(reached).toBe(24);
  });

  it('returns exactly 2000 templates, refuses selectors above the bound and keeps later paged parents complete', async () => {
    await f.exec("INSERT INTO store_product_rule(id,rule_name,rule_value) SELECT 2000+n,'历史规格'||n,'[]' FROM generate_series(1,1998) AS n");
    expect(await f.service.templates(query(), ruleActor())).toHaveLength(2000);
    expect(await f.service.templates(query(), ruleActor(), false)).toHaveLength(2000);
    await f.db.insert(storeProductRule).values({ id: 5000, ruleName: '溢出规格', ruleValue: '[]' });
    await expect(f.service.templates(query(), ruleActor())).rejects.toThrow('2000');
    await expect(f.service.templates(query(), ruleActor(), false)).rejects.toThrow('2000');
    const page = await f.service.list(new URLSearchParams('page=21&limit=100'), ruleActor());
    expect(page).toMatchObject({ count: 2001, list: [{ id: 10 }] });
    expect(await f.db.select().from(systemLog)).toEqual([]);
  });

  it('copies the actual product editor template into real saved SKU snapshots that survive template edit/delete', async () => {
    const product = new ProductAssociationService(f.container);
    const template = (await product.editorOptions()).sku_rule_templates.find(row => row.id === 10)!;
    const dimensions = structuredClone(template.dimensions);
    const attrs = dimensions[0].detail.flatMap((a, ai) => dimensions[1].detail.map((b, bi) => ({
      suk: `${a},${b}`, detail: { [dimensions[0].value]: a, [dimensions[1].value]: b },
      price: 19.5 + ai + bi, cost: 8, ot_price: 30, vip_price: 17, stock: 4 + ai + bi,
    })));
    const actor = { id: 101, name: 'Copied rule SKU fixture', ip: '127.0.0.1' };
    const body = { store_name: '规格复制商品', unit_name: '件', product_type: 0, spec_type: 1,
      items: dimensions, attrs, sku_rule_id: 10 };
    const saved = await product.save(0, body, actor);
    expect(saved.sku_verified).toBe(true);
    async function productSnapshot(id: number) {
      return { row: (await f.db.select().from(storeProduct).where(eq(storeProduct.id, id)))[0],
        dimensions: await f.db.select().from(storeProductAttr).where(eq(storeProductAttr.productId, id)).orderBy(storeProductAttr.id),
        values: await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, id)).orderBy(storeProductAttrValue.id),
        results: await f.db.select().from(storeProductAttrResult).where(eq(storeProductAttrResult.productId, id)).orderBy(storeProductAttrResult.id),
        stocks: await f.db.select().from(storeProductStockRecord).where(eq(storeProductStockRecord.productId, id)).orderBy(storeProductStockRecord.id) };
    }
    const before = await productSnapshot(saved.id);
    expect(before.dimensions).toHaveLength(2); expect(before.values).toHaveLength(4); expect(before.results).toHaveLength(1);
    expect(new Set(before.values.map(row => row.unique)).size).toBe(4);
    expect(before.values.every(row => row.unique.length === 8 && row.stock > 0 && Number(row.price) > 0)).toBe(true);
    await f.service.save(10, ruleBody({ rule_name: '新维度规格', spec: [{ value: '材质', detail: ['钢'] }] }), ruleActor());
    expect(await productSnapshot(saved.id)).toEqual(before);
    await remove(10);
    expect(await productSnapshot(saved.id)).toEqual(before);
    expect((await product.editorOptions()).sku_rule_templates.map(row => row.id)).not.toContain(10);
    const copied = await product.save(0, { ...body, store_name: '删除后复制商品' }, actor);
    expect(copied.sku_verified).toBe(true);
    const after = await productSnapshot(copied.id);
    expect(after.values.map(row => ({ suk: row.suk, price: row.price, stock: row.stock })))
      .toEqual(before.values.map(row => ({ suk: row.suk, price: row.price, stock: row.stock })));
    expect(await productSnapshot(saved.id)).toEqual(before);
  });
});
